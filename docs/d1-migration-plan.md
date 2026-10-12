# Plan: move mail storage to D1 and rebuild search

Status: in progress. Phases 0 to 2 are done: [phase 0 results](d1-phase0.md); every caller goes through `mailStore(env)`; the D1 store (`workers/store/d1/`) implements the whole contract and `tests/store-conformance.test.mjs` runs one script of about 80 calls against both stores with matching results. The classic and unified views were retired on 2026-10-11. Phase 3 is done too: the whole app runs on D1 with `STORAGE=d1` and a `DB` binding. Phase 4 adds the cron that sends scheduled mail on D1. Phase 5 adds the copy from the Durable Objects, run from the Mail index page. Phase 6 is under way: the maintainer's deployment moved to D1 on 2026-10-11 and is in its two-week window until 2026-10-25.

## Summary

Mail now lives in one Durable Object per address (`MailboxDO`) plus one combined index (`MailIndexDO`). This plan replaces both with one D1 database. The chat agent and MCP server stay Durable Objects; they hold chat history, not mail.

Why:

- **One copy of the data.** The per-address objects are the source of truth and the index is a derived copy kept in sync by an outbox, retries, a rebuild job and a parity page. With D1 every query reads the same tables, and that sync layer is deleted.
- **Users can see and keep their data.** D1 has a SQL console in the dashboard, `wrangler d1 execute`, and Time Travel restore to any minute in the last 30 days. Durable Object storage has none of these for a self-hoster.
- **Contributors know it.** Plain SQL migration files instead of migrations that run inside each object, and no permanent class names to protect.
- **Search gets rebuilt once, properly.** One query language and one engine for every view, the agent and MCP, with relevance ranking and highlighted snippets. The search window becomes a full-width command surface (see Search).
- **Nothing is lost on scale for this audience.** Each deployment serves one owner. Every combined-inbox query already goes through a single index object, which has the same one-writer limit as a D1 database.

What we give up:

- **Exact-time alarms per mailbox.** Scheduled send moves to a one-minute Cron Trigger, so a message goes out up to a minute after its time.
- **Synchronous transactions.** D1 has `batch()` (atomic, but no reads between statements) instead of `transactionSync`. Read-then-write logic has to become single statements or batches.
- **10 GB per address.** D1 caps the whole database at 10 GB on Workers Paid. Bodies over a threshold and all attachments live in R2, so this is hundreds of thousands of messages.

## Current state

### Durable Object classes (`wrangler.jsonc`)

| Class | Holds | After this plan |
|---|---|---|
| `MailboxDO` (one per address) | `folders`, `emails`, `attachments`, `email_labels`, `index_outbox`, `index_meta`, `scheduled_sends`, `send_keys` | Removed |
| `MailIndexDO` (one) | `messages`, `messages_fts`, `labels`, `message_labels`, `label_auto`, `saved_searches`, `mailbox_cursor`, `rebuild_job`, `index_meta`, `undo`, `bulk_job` | Removed |
| `EmailAgent` | Chat history (Agents SDK) | Stays |
| `EmailMCP` | MCP sessions (Agents SDK) | Stays |

The index is not fully derived. `labels`, `label_auto`, `saved_searches`, `undo` and `bulk_job` exist only there. Label names are also backed up to R2 at `backups/labels.json`.

### R2 keys

| Key | Holds | After this plan |
|---|---|---|
| `attachments/<email>/<att>/<file>` | Attachment bytes | Stays |
| `mailboxes/<address>.json` | Mailbox settings (display name, signature, agent prompt) | Moves to D1 `mailboxes` |
| `config/agent-model.json` | Agent provider, model, OpenRouter key | Stays in R2. No route serves it, and keeping the key out of the database keeps it out of exports and Time Travel. |
| `backups/labels.json` | Label backup | Removed. Time Travel covers it. |

### Code that talks to storage

`getMailboxStub`, `getMailIndexStub`, `env.MAILBOX` and `env.MAIL_INDEX` appear in 11 files: `workers/index.ts`, `workers/agent/index.ts`, `workers/lib/{tools,email-helpers,mailbox,combined-inbox,folder-import,mail-index-stub}.ts`, `workers/routes/reply-forward.ts` and both Durable Objects. Most SQL is already in pure functions over the synchronous `Exec` adapter (`workers/lib/sql-exec.ts`), which node:sqlite tests run directly.

### Places that rely on `transactionSync`

- `MailboxDO` change recording: each write plus its `index_outbox` row. This goes away with the index.
- `MailIndexDO.applyBatch`, `purgeMailbox`, the rebuild step: these go away with the index.
- `saveUndo`, `takeUndo`, `markLabelsAuto`, `deleteLabelRows`, the bulk job step: each needs rewriting as one statement or one `batch()`.

## Target design

### Schema

The schema is [`migrations/0001_init.sql`](../migrations/0001_init.sql). It's tested on node:sqlite, local D1 and production D1 by `tests/d1-schema.test.mjs`. In short:

| Table | Holds |
|---|---|
| `mailboxes` | One row per address, with its settings as JSON (was `mailboxes/<address>.json` in R2) |
| `folders` | System and custom folders per address |
| `messages` | Every message from every address, with `mailbox_id`. Integer `id` keys the search indexes; text `email_id` keeps today's ids. Column names match the combined index (`state`, `thread_key`, `sender_addr`, `recipients`, `unread`, `deleted`), with `state`, `thread_key`, `unread` and `deleted` as generated columns. Bodies over 512 KB live in R2 (`body_key`). |
| `messages_fts` | Contentless word index with a weighted `bm25` rank |
| `messages_trigram` | Contentless substring index over subject, sender, recipient and attachment names |
| `messages_vocab` | Terms and counts from the word index |
| `attachments`, `attachment_text` | Attachment metadata, and extracted text for search |
| `labels`, `message_labels`, `label_auto` | Labels across every address, the same tables as the index |
| `saved_searches`, `scheduled_sends`, `send_keys`, `undo`, `bulk_job` | As today, with `mailbox_id` where they belong to one address |

Matching the index's column names means the combined list, facet and folder queries in `workers/lib/mail-index-sql.ts` run on D1 unchanged. They are generators that yield SQL steps: `runSync` drives them over the Durable Object's synchronous `Exec`, and `runAsync` drives them over D1. `tests/d1-query.test.mjs` runs the same queries on both and requires identical results. Production D1 computes the generated columns and uses the `(state, date)` index for the list.

A trigger removes a message's search rows when it is deleted, including when a mailbox delete cascades to its messages. The Worker writes search rows itself, in the same `batch()` as the message, because `body_text` is derived from the HTML body. A message's folder must be one of its own mailbox's folders, enforced by a composite foreign key. Production D1 enforces foreign keys by default.

Notes:

- `state` in the index (`inbox`, `sent`, `folder:<id>`) becomes `folder_id` plus a computed expression. `folderToState` stays as a SQL `CASE`, or the query builder filters on `folder_id` directly.
- `thread_key` (address + separator + conversation) becomes the pair `(mailbox_id, thread_id)`. Cursors and the UI's `open=` parameter already carry the address, so URLs keep working.
- The FTS row is written in the same `batch()` as the message. `body_text` is the plain text of the full body, capped at 256 KB (today: 32 KB). In phase 0 a message cost about 11 KB in total with this design (6.9 KB row, 3.9 KB word index, 0.4 KB trigram), so 10 GB holds about 900,000 messages of that size.
- Tombstones, `generation`, `seq`, `mailbox_cursor`, `rebuild_job` and `index_outbox` have no equivalent. They exist only to keep the copy in sync.

### Large bodies

D1 accepts single values up to about 8 MB (phase 0: 8 MB stored, 9 MB refused with `SQLITE_TOOBIG`). Large rows still slow every read that touches them, so bodies over `BODY_INLINE_MAX` (512 KB) go to R2 at `bodies/<message id>.html`, with `body_key` set and `body` NULL. `snippet` and the FTS row are built from the full body before it is stored, so search still covers it. `getEmail` reads R2 when `body_key` is set.

### Access layer

Add `workers/store/` with one async interface:

```ts
// workers/store/types.ts
export interface Sql {
	all<T = Row>(sql: string, ...params: unknown[]): Promise<T[]>;
	run(sql: string, ...params: unknown[]): Promise<{ changes: number }>;
	/** Atomic: every statement commits or none do. */
	batch(statements: { sql: string; params: unknown[] }[]): Promise<Row[][]>;
}
```

- `d1Sql` in `workers/store/sql.ts` wraps `env.DB` (`prepare().bind().all()`, `env.DB.batch()`). `chunkByBytes` splits a long statement list into batches under 24 MB.
- `tests/helpers/sql.mjs` is an async `Sql` over node:sqlite that refuses what D1 refuses: more than 100 bound parameters, SQL-level transactions, a value over 8 MB, a batch over 32 MiB. Unit tests stay in node and stay fast.
- Id lists use `json_each(?)` with one JSON parameter instead of `IN (?, ?, ...)`, which removes the 100-parameter ceiling from bulk actions.

The D1 store's SQL is written new in `workers/store/d1/` over `Sql`, against the new schema. Today's SQL modules (`mail-index-sql.ts`, `mail-bulk-sql.ts`, `mailbox-bulk.ts`, `scheduled-send.ts`, `send-keys.ts`, `index-rows.ts`, the `MailboxDO` methods) stay as they are, serving the Durable Objects until removal. Porting them to async in place was the first version of phase 1. It was dropped for two reasons. The queries change anyway: one `messages` table with `mailbox_id` replaces per-mailbox tables. And awaiting inside a Durable Object would open gaps between a read and the write that depends on it, where `transactionSync` has none today. Where a module's logic carries over (filter compilation, cursors, the scheduled-send runner), the D1 version reuses its pure parts. The operations that relied on `transactionSync` become:

| Operation | D1 form |
|---|---|
| Claim a send key | `INSERT INTO send_keys ... ON CONFLICT DO NOTHING RETURNING state`. If nothing comes back, `SELECT` the existing row. One writer, so there is no race. |
| Take an undo entry | `DELETE FROM undo WHERE id = ? RETURNING payload` |
| Mark labels auto | `UPDATE labels SET auto_applied_at = ? WHERE id IN (SELECT value FROM json_each(?)) RETURNING id` |
| Delete a label | `batch([DELETE message_labels..., DELETE labels...])`, or rely on `ON DELETE CASCADE` |
| Create a message | `batch([INSERT messages, INSERT messages_fts, INSERT attachments...])`. The FTS insert uses `last_insert_rowid()`, or `RETURNING rowid` followed by a second batch. |
| Bulk step | One `UPDATE ... WHERE id IN (SELECT value FROM json_each(?))` per chunk |

Drizzle (`drizzle-orm/durable-sqlite`) builds most of `MailboxDO`'s queries: about 96 references to `this.db` and the schema tables. Moving to `drizzle-orm/d1` keeps those queries and changes the driver and the awaits. Dropping Drizzle would mean rewriting them as raw SQL. Recommendation: keep Drizzle on D1 for the mailbox queries, and leave the index and bulk SQL raw as it is today.

### Jobs that used alarms

| Job | Now | After |
|---|---|---|
| Scheduled send | `MailboxDO` alarm at the exact time | Cron Trigger `* * * * *` runs `runDueScheduled`. A row is claimed with `UPDATE scheduled_sends SET claimed_at = ? WHERE message_id = ? AND claimed_at IS NULL RETURNING ...`, so two overlapping cron runs can't both send it. The `draft:<id>` send key is the second guard. Claims older than 10 minutes are released. |
| Index push retries | `MailboxDO` alarm | Deleted |
| Index rebuild | `MailIndexDO` alarm | Deleted. A "Reindex search" admin action replaces it: it rebuilds `messages_fts` from `messages` in chunks. |
| Large bulk actions (over `BULK_INLINE_LIMIT`, 500) | `MailIndexDO` alarm | The request runs the first chunk. The same cron runs the rest of `bulk_jobs` in chunks of 1,000. With a cron, a large action can take minutes, so the UI gains progress polling on `bulkJob(id)`. Nothing in `app/` calls it today. |
| Old send keys, undo rows | Pruned on use | Same, plus a daily sweep in the cron |

This adds no new Cloudflare product: one D1 binding and one cron.

### What stays per address

Each address keeps its own folders, threads, rate limit (now `WHERE mailbox_id = ? AND folder_id = 'sent'`), send keys, signature, display name and agent prompt. Per-address isolation becomes a column instead of a separate database. Every query that takes a mailbox must filter on `mailbox_id`, and tests check that (see Testing).

### Configuration

```jsonc
"d1_databases": [
	{ "binding": "DB", "database_name": "open-mailroom", "database_id": "<set by deploy>", "migrations_dir": "migrations" }
],
"triggers": { "crons": ["* * * * *"] }
```

- `npm run deploy` runs `wrangler d1 migrations apply DB --remote` before `wrangler deploy`.
- The Deploy to Cloudflare button provisions D1 and applies migrations, as it does for cf-mailroom.
- `INDEX_SYNC_ENABLED` is removed.
- During the transition, a `STORAGE` var takes `do` or `d1` (see Rollout). It is removed in the last phase.
- Durable Object migrations are append-only. Removing the classes is a new tag with `deleted_classes: ["MailboxDO", "MailIndexDO"]`, applied only after the data is copied and the rollback window has passed. It permanently deletes their storage.

## Search

### What is wrong today

| Problem | Where |
|---|---|
| Two engines. The mail view searches the FTS index. The agent's per-address `search_emails` and MCP `search_emails` scan with `LIKE`. The same words give different results. | `MailIndexDO`, `MailboxDO.searchEmails` |
| Every word is an AND prefix match. No exact phrase, no exclusion, no OR, no `cc:`, no `filename:`, no typed relative dates. | `buildMatch` in `mail-index-sql.ts` |
| Results sort by date, sender or subject (`SORTS`). There is no relevance order, so a strong match from last year sits under a weak one from today. | `SORTS` in `mail-index-sql.ts` |
| The FTS table is contentless, so it can't return snippets or highlights. Rows show the first lines of the message, and the client highlights only the first term it finds. | `messages_fts`, `highlight()` in `model.ts` |
| Body text is cut at 32 KB. Attachment names and contents aren't searched. | `BODY_TEXT_LIMIT` |
| The search window shows only when the box is empty and closes on the first keystroke. It's capped at 720px instead of spanning the bar. It offers static filters and addresses only: no live results, no completion, no recent or saved searches, no people. `saved_searches` has a table but no API or UI. | `SearchBar.tsx`, `.pg-suggest` in `postal.css` |

### One query language

One parser, `shared/search-query.ts`, is used by the search bar, the API, the agent's tools and MCP. It turns text into a typed `SearchQuery`, and one compiler turns that into SQL.

| Operator | Meaning | Example |
|---|---|---|
| words | Every word, any field, prefix match | `quarterly report` |
| `"..."` | Exact phrase | `"wire transfer"` |
| `-word`, `-op:value` | Exclude | `invoice -from:stripe` |
| `OR` | Either side | `from:stripe OR from:paddle` |
| `from:` `to:` `cc:` | Person, address or domain. `to:` also picks one of your addresses. | `from:example.org` |
| `subject:` | Words in the subject | `subject:"renewal notice"` |
| `label:` | Label by name | `label:Receipts` |
| `in:` | View or folder: `inbox`, `unread`, `starred`, `drafts`, `sent`, `archive`, `spam`, `trash`, `all` (every folder except spam and trash, as today), `anywhere` (new: all of them), or a folder name | `in:anywhere invoice` |
| `is:` | `unread`, `read`, `starred` (today), plus `scheduled`, `replied` (new) | `is:unread` |
| `has:` | `attachment` and `unsubscribe` (today), plus `pdf`, `image`, `link`, `draft` (new) | `has:pdf` |
| `filename:` | Attachment name or type | `filename:contract.pdf` |
| `before:` `after:` | Date, or relative: `7d`, `3w`, `2m`, `1y` | `after:2026-01-01`, `after:30d` |
| `newer:` `older:` | Relative age | `older:1y` |
| `larger:` `smaller:` | Message size including attachments | `larger:5mb` |
| `list:` | Mailing list id | `list:news.example.org` |
| `sort:` | `relevance` (default with words) or `date` | `sort:date` |

Unknown operators stay as plain words, so `ratio:4:3` still searches. Values that don't parse (`before:soon`) show an inline error in the search window instead of being dropped without a word.

### One engine

- Every surface runs the same compiled query against the D1 tables: the mail view, `search_all_mail`, and `search_emails`. `search_emails` becomes `search_all_mail` with an address filter. MCP gets the same two tools.
- **Relevance.** The table's `rank` is set to `bm25(6, 4, 3, 2, 2, 2, 1)`: subject weighs most, body least. Ranking time grows with the number of matches: under 50 ms at the 13,000 matches measured, 0.22 to 0.46 s at 100,000 (phase 0). So every search counts its matches first (15 to 34 ms). With 20,000 or fewer it sorts by relevance; that line is an extrapolation, confirmed on real mail in phase 2. With more it sorts newest first (10 to 40 ms at any size), and the window and list offer "Sort by relevance" as an explicit action. A recency term breaks near-ties. The weights get tuned against a fixture set of 200 messages and 30 queries with expected top results. That set is checked in, so ranking changes show up in review.
- **Conversations.** Results group by conversation. The best-ranked message in a conversation represents it, and the row says how many messages matched.
- **Snippets.** The Worker builds them for the rows on screen only (6 in the window, 50 in the list). It strips the body to text, finds the query terms with the same tokenizing rules as the index (case, diacritics, prefixes), and takes about 18 words around the best cluster. FTS5's `snippet()` re-runs the match and cost 57 to 160 ms on broad words in phase 0, and it doesn't work on a contentless table. The server HTML-escapes the text and then adds `<mark>` and `</mark>`, so mail text never reaches the page unescaped. A test feeds `<script>` and `&lt;` cases through it.
- **Facets** ("Narrow" counts) count over the newest 5,000 matches through `rowid IN (SELECT rowid FROM messages_fts WHERE … ORDER BY rowid DESC LIMIT 5000)`. That took 25 to 45 ms at 100,000 matches, against 280 ms for a join against every match.
- **One `MATCH` per statement.** In phase 0 a statement with two `MATCH`es on the same table failed six times with D1's CPU-limit reset, and took 28 s with a smaller limit. A test fails on that pattern in `workers/store/search.ts`.
- **Substring fallback.** Words of three or more characters that match nothing in `messages_fts` are retried against `messages_trigram`. This finds codes, order numbers and partial addresses.
- **Did you mean.** When a search returns nothing, the Worker reads candidate terms from `messages_vocab` that share the first two letters of each word. It suggests the one with the smallest edit distance and the most documents.
- **Attachment text.** PDFs, Word, Excel and text attachments under 10 MB are converted with Workers AI `toMarkdown` and stored in `attachment_text`, capped at 64 KB each. The job runs on the cron and doesn't hold up inbound mail. That text is added to the message's `body_text` field in the index. It's off by default (`ATTACHMENT_SEARCH=true` turns it on), because it costs Workers AI calls per attachment.

### Asking in plain words

If the text reads like a request rather than keywords, the search window offers **Ask: "receipts from stripe last month over $100"**. Plain-words requests are:
- four or more words with no operators, or
- text starting with words like "find", "show", "where" or "emails".

Choosing it sends the text once to `POST /api/v1/search/interpret`. The agent model (Workers AI by default, or the OpenRouter model from Settings) returns a `SearchQuery` under a strict schema, plus a one-line explanation. The bar then shows the operators it produced, for example `from:stripe.com label:Receipts after:2026-09-01 before:2026-10-01 receipt`, so you can see and edit what will run. It never runs a hidden query. It costs one model call per request and nothing per keystroke. If the call fails, the text runs as a word search.

Questions that need reading the mail ("what did Ann say about the contract?") go to the agent panel with the search as context, using the panel's existing `search_all_mail`.

Meaning-based search, which finds "the email where they offered a discount" without the word "discount", would need Vectorize and embeddings for every message. It's left out of this plan. It can come later as an opt-in setting that merges vector results with FTS results.

### The search window

The window drops from the bar and spans its full width (`left: 0; right: 0`), up to `min(600px, 72vh)` tall. Below 768px it fills the screen under the bar, with one column and the key hints hidden. It stays open while you type, and its sections follow what you type.

**Empty box**

| Section | Content |
|---|---|
| Recent | Last 8 searches run in this browser (localStorage). Each can be removed. |
| Saved | Saved searches from D1, with live counts. `⌘S` or a Save button in the window saves the current search. Saved searches also appear in the sidebar. |
| People | The 6 senders you get the most mail from in the last 90 days, by name and address |
| Filters | Today's filters (unread, starred, attachments, labels) with counts |
| Addresses | Today's address list with counts |
| Ask | "Ask the agent…" opens the panel |

**Typing words**

| Section | Content |
|---|---|
| Top results | Up to 6 live results, debounced 120ms. Each row shows sender, subject, the highlighted snippet, the address swatch and the date. `↵` on a row opens that message. |
| Narrow | Filters inferred from the words, with counts for this search: typing `stripe` offers `from:stripe.com (42)` and `label:Receipts (31)`. Counts come from the same facet query the list uses. |
| Ask | Shown when the text reads like a request (see Asking in plain words) |
| Did you mean | Shown when nothing matched: the suggested spelling, "Search everywhere" if the current view hides matches in spam or trash, and "Remove `is:unread` (12 results)" for the filter that excludes the most |

**Typing an operator.** With the cursor inside `from:st`, the window completes the value:

| Operator | Completes with |
|---|---|
| `from:`, `cc:` | Senders and domains by prefix of name or address, most frequent first |
| `to:` | Your addresses, then recipients |
| `label:` | Labels, with counts |
| `in:` | Views and folders |
| `is:`, `has:`, `sort:` | The fixed values |
| `before:`, `after:` | Today, Yesterday, 7 days ago, Start of this month, Start of last month, and a date field |
| a bare word ending in `:` | Every operator, with a one-line description |

`Tab` accepts the highlighted completion and keeps typing. An operator cheat sheet opens from a `?` in the window footer.

**Keys**

| Key | Does |
|---|---|
| `↑` `↓` | Move through every row, across sections |
| `Tab` | Accept the completion |
| `↵` | On a result: open it. On a suggestion: apply it. With nothing highlighted: run the search and open the first result (today's behavior). |
| `⌘↵` | Run the search and keep the list in focus without opening anything |
| `⌘S` | Save the search |
| `Esc` | Close the window. A second `Esc` clears the box. |

**Accessibility.** The input is a combobox. Each section is a `role="group"` with a label inside one `listbox`. `aria-activedescendant` moves across groups, and a polite live region announces the result count.

**Design rules.** `DESIGN.md` applies: one 6px radius, no accent bars, and selected rows shown with fill. Snippet `<mark>` uses a fill, not an underline or a bar. `tests/design-rules.test.mjs` covers the new classes.

### API

| Route | Returns |
|---|---|
| `GET /api/v1/mail?q=…&sort=relevance` | Today's list response, plus `snippetHtml` and `matchCount` per conversation |
| `GET /api/v1/search/suggest?q=…&at=<cursor offset>` | One round trip for the window: `completions`, `results` (top 6 with snippets), `narrow` (filters with counts), `didYouMean`, `interpretable` (boolean), `errors` (operators that didn't parse). Target: under 60 ms of SQL. Phase 0 met it for searches with up to about 20,000 matches. Broad words meet it only through the newest-first rule and capped facets above. |
| `POST /api/v1/search/interpret` `{ text }` | `{ query, text, explanation }`, or an error that the client turns into a plain word search |
| `GET/POST/PUT/DELETE /api/v1/saved-searches` | Saved searches CRUD over the existing table |

The agent's `search_all_mail` and MCP's `search_all_mail` take a `query` string in the same language, next to the structured fields they have today, and return snippets.

### Order

The query language, the search window and the suggest API don't depend on storage. They can ship on the current `MailIndexDO` before D1, then move with everything else. The engine changes (contentless word index, trigram, ranking, snippets) go straight into the D1 schema, so they aren't built twice. See phases S1 to S6.

## Moving existing deployments

Every deployment that already holds mail needs a one-time copy. It runs inside the Worker, so it reads Durable Object storage directly and writes D1 through the binding.

1. **Export methods on the old classes.**
   - `MailboxDO.copyStart`, `copyPage`, `copyChanges`, `copyAck`, `copyRows`, `copyMeta`, `copyStatus` and `copyStop` (SQL in `workers/lib/copy-rows.ts`). A page is up to 100 emails with bodies, attachment metadata, labels and the list's conversation id, and stops early at 8 MB of bodies.
   - `MailIndexDO.copyGlobals()` returns `labels`, `label_auto` and `saved_searches`.
   - The plan first said to pause index sync so the index outbox would hold every change. A Worker can't change its own vars, and pausing would freeze the combined inbox. Instead, `copyStart` turns on tracking, and from then on `recordChanges` also writes each changed id to a `copy_outbox` table (mailbox migration 12). Only the copy reads and clears it. Index sync carries on.
2. **The copy job** (`workers/store/copy-job.ts`). `POST /api/v1/admin/migrate-to-d1` with `{ confirm: true }` starts it; `GET` returns progress and the parity report. It refuses when D1 isn't bound, when `STORAGE` is already `d1`, when a copy exists, or when D1 already holds mail. `copy_job` and `copy_mailboxes` in D1 track it, and the cron advances it 20 seconds at a time.
   - Each run first copies labels and saved searches, then pages through each mailbox in id order. Every write deletes and re-inserts the message, so a page that runs twice changes nothing. Bodies over 512 KB go to R2.
   - A page can carry a label made after that run's label copy. The writer checks and copies labels first when one is missing.
3. **Catch-up.** After every page is copied, each mailbox's `copyChanges` is re-copied (or deleted, for ids that are gone) and acked, until a pass finds nothing. Then settings, custom folders, scheduled sends and send keys are brought in line. State becomes `ready`, and every later run repeats the catch-up, so D1 stays current while the deployment waits to switch.
4. **Check.** A parity report compares, per address, message counts per folder with unread and starred, label counts, attachments and scheduled sends, plus the label list. The Mail index settings page shows it under Copy to D1.
5. **Cut over.**
   - Set `STORAGE=d1` and deploy. All reads and writes go to D1 from then on. MailboxDO stops sending scheduled mail and stops re-arming its alarm for it.
   - The first cron run on D1 makes the last pass before it sends anything: messages and scheduled sends only, since D1's settings and labels are now newer. A D1 schedule is removed only if its draft came from the old store, so mail scheduled on D1 in that minute survives. Then each mailbox stops tracking and drops its scheduled rows (the drafts stay), and the job is `done`.
   - Known gap: a change on the old store in the minute before the deploy overwrites a change to the same message on D1 in the minute after. The README says to switch in a quiet hour.
6. **Rollback window (two weeks).**
   - During it, inbound mail is also written to the old `MailboxDO` (`mirrorInbound`), so mail received after cutover is not lost if storage has to move back.
   - Other changes made after cutover (read state, labels, moves, sends) are not written back. A rollback loses them. The README says so.
   - Problems inside D1 itself are fixed with Time Travel, not by rolling back.
7. **Remove.** Delete the dual write, the `STORAGE` flag, the export methods, the old classes (with the `deleted_classes` migration) and `INDEX_SYNC_ENABLED`.

The copy job has a README section (Moving to D1) and a Copy to D1 button on the Mail index settings page, which shows progress and the parity result.

## Phases

| # | Phase | Output | Rough size |
|---|---|---|---|
| 0 | Checks | Done. See [Phase 0 results](#phase-0-results). | 1 day |
| 1 | Store contract (done) | `workers/store/`: `MailStore` with `mailbox(id)` (one address) and `all()` (every address), and its Durable Object implementation. All 47 call sites in the routes, tools, agent, MCP and helpers go through `mailStore(env)`. Index-sync work that D1 won't need (index status, rebuild, `setMailboxId`, `purgeMailbox`) goes through `durableObjectInternals(env)`. Also: the `Sql` interface with `d1Sql` and byte-sized `chunkByBytes`, and an async node:sqlite `Sql` in `tests/helpers/sql.mjs` that refuses what D1 refuses. A test fails if code outside `workers/store/` or the Durable Objects touches the mail bindings. No behavior change. | 1 day |
| 2 | D1 schema and store (done) | `migrations/0001_init.sql` with the index's column names, so the list, facet, bulk and label SQL runs on D1 unchanged: those functions are generators driven by `runSync` (Durable Objects) and `runAsync` (D1). `workers/store/d1/` holds the per-address store, the all-mail store and the bulk op applier. Bulk actions apply inline at any size on D1, since an op is one statement. The conformance test compares both stores call by call. | 2 days |
| 3 | Switch storage (done) | `STORAGE=d1` with a `DB` binding picks the D1 store. The mailbox list and settings are in the contract (`mailStore(env).mailboxes`): R2 records on the Durable Object store, the `mailboxes` table on D1. On D1 the mail index status page reports per-address counts from the one copy, and rebuild declines. `DELETE /api/v1/mailboxes/:id` is gone: no view used it, and on D1 it would cascade to the mail. Checked by running the app locally on D1 (list, reader, archive and undo, search, labels, drafts, settings). | 1 day |
| 4 | Jobs (done) | A one-minute cron (`workers/cron.ts`, `triggers.crons` in `wrangler.jsonc`) sends due scheduled mail on D1, up to a minute late. Each run claims its rows first, so overlapping runs send once; the `draft:<id>` send key is the second guard. A claim older than 10 minutes is taken over. Failures retry after 15 minutes, three attempts in all. On the Durable Object store the cron returns at once. Bulk actions need no job chunks on D1 (phase 2). Sweeps need no job: expired send keys are dropped on each claim, expired undo rows on each save. Large bodies were already in R2 (phase 2). Reindex search moves to S4. `tests/cron.test.mjs` covers it. | 2 days |
| 5 | Copy job (done) | `workers/lib/copy-rows.ts` (mailbox side), `workers/store/d1/copy.ts` (D1 writer), `workers/store/copy-job.ts` (the job), the `migrate-to-d1` routes, the Copy to D1 section on the Mail index page, `mirrorInbound` for the two-week window, and the README section. A copy outbox replaces pausing index sync. `tests/copy-job.test.mjs` copies two addresses in slices with changes made mid-copy, compares about 40 reads between the stores, then cuts over; `tests/copy-rows.test.mjs` covers the outbox and page sizes. Checked locally in the browser: 120 messages copied from the page, cut over by the cron, mail served from D1. "Reindex search" moves to S4, where a tokenizer or weight change would need it. | 3 to 4 days |
| 6 | Move your own deployment (in progress) | Moved 2026-10-11: 125 messages over 19 addresses copied with matching counts, then `STORAGE=d1`. The cron trigger took about 30 minutes after the last schedule change to start firing, so the final pass ran late; nothing was waiting to send. Two-week window until 2026-10-25. | 2 weeks elapsed, about 1 day of work |
| S1 | One query language (done) | `shared/search-query.ts` parses; `workers/store/search.ts` compiles to one FTS `MATCH` plus column clauses, on the index and on D1. The mail view, the list API, `search_all_mail`, `label_matching` and both `search_emails` use it; `search_emails` is `search_all_mail` limited to one address, and the `LIKE` search in both stores is gone. Operators that need D1 tables (`cc:`, `filename:`, sizes, `is:scheduled`, `has:pdf`, `has:image`) are refused on the index. A bad value is left out and named in the search bar. `has:link` waits for S4, which adds the column; `sort:relevance` is parsed and ranks in S4. `tests/search-query.test.mjs` (parser table) and `tests/search-compile.test.mjs` (both schemas, one `MATCH` per statement, API and tools agree). | 2 to 3 days |
| S2 | Search window (done) | `SearchWindow.tsx` spans the bar and stays open while you type; below 768px it fills the screen in one column. Empty box: Recent (localStorage, removable), People (top senders over 90 days from the facet query), Filters, Addresses, Ask. Typing: Top results (the list's first 6), Narrow (facets of the search), Ask for plain-words requests, and on no results "Search everywhere" and "Remove" for each filter term. Completion for every operator from data the page already has. Keys and the cheat sheet as specified; the logic is in `search-window.ts`, tested in `tests/search-window.test.mjs`. Moved to S3, since each needs a server query: saved searches and `⌘S`, completion by prefix across all mail, `to:` recipients, counts on "Remove", and the date field. Snippets and "Did you mean" stay in S4. | 3 to 4 days |
| S3 | Suggest API (done) | `workers/lib/search-suggest-sql.ts`, run by both stores. `GET /api/v1/search/suggest` returns `completions` for `from:` (senders and domains by prefix, through one FTS `MATCH`), `to:` and `cc:` (recipients of the newest 500 matching messages), `people` for an empty box, `count`, `narrow` (top domains, labels, unread, attachments), `nothing` (what searching everywhere or dropping each filter would find, with counts), `interpretable` and `errors`. It leaves out `results`: the window shows the list query it already runs. `didYouMean` is null until S4. `/api/v1/saved-searches` lists (with counts over All mail), creates, renames, reorders and deletes; `saved_searches.filter` holds the search text. The window gains Saved, `⌘S` and a Save button, server completions, counts on "Remove" and "Search everywhere", and a date field; the sidebar lists saved searches. Saved searches on the combined index aren't backed up to R2 the way labels are. `tests/search-suggest.test.mjs` runs on both schemas; `tests/worker-index.test.mjs` covers the Durable Object calls. | 2 days |
| S4 | Engine on D1 (done) | The word index, trigram table and vocab came with phase 2. Searches with words rank with `bm25(messages_fts, 6, 3, 3, 2, 1, 2)` (subject, sender name, sender address, recipients, body, attachment names), in steps of 0.5 so near-ties go newest first. The list counts matches first and ranks at 20,000 or fewer (`RANK_LIMIT`); above that it is newest first with `rankSkipped`, and `sort:relevance` or `sort=relevance` ranks anyway. `sort:date` and oldest-first keep dates. The ranked query joins the index in place of the MATCH clause, so a statement still holds one MATCH. The best-ranked message represents its conversation and `match_count` says how many matched. `snippet_html` is built in the Worker for the page's rows (`workers/lib/snippets.ts`) from the first 64 KB of each body; R2 bodies use the stored opening lines. Facets and Narrow count the newest 5,000 matches (`FACET_CAP`). A lone word of three or more letters with no word match falls back to `messages_trigram`, resolved to ids first; bulk actions resolve it the same way. "Did you mean" reads `messages_vocab`. `has:link` needs `migrations/0002_has_link.sql`, set on insert and backfilled 200 rows a minute by the cron. The agent's and MCP's `search_all_mail` return the snippet text, `matched` and `order`. The list shows a Relevance/Newest switch that writes `sort:date`. Ranking fixture: `tests/fixtures/search-corpus.json` (200 messages, 30 queries, generated so newer messages only mention the words); `tests/search-ranking.test.mjs` requires every query's message first and date order to get at most 3 right. Engine tests: `tests/search-engine.test.mjs`. | 3 days |
| S5 | Ask in plain words (done) | `POST /api/v1/search/interpret` (`workers/lib/search-interpret.ts`) sends the request, today's date in the reader's zone, label names and the deployment's addresses, never mail, to the model once. The model answers with `{terms: [{field, value, exclude?}], explanation}`; each term is checked on its own against the schema, then by the parser and compiler for this store, and dropped if it fails. A failed call or an answer with nothing usable returns the request as the query, so it runs as a word search. On Workers AI it uses `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (1 to 2 s locally) rather than the agent model, which reasons first and took 10 to 27 s; OpenRouter users get their chosen model. The window offers Turn into a search and Ask the agent about it for request-like text, then shows the explanation with Undo. `tests/search-interpret.test.mjs` stubs the model. | 2 days |
| S6 | Attachment text (done) | New mail queues its PDF, Word, Excel, OpenDocument, text and CSV attachments up to 10 MB in `attachment_text` (`workers/lib/attachment-kind.ts`); `migrations/0003_attachment_text.sql` queues older ones by the same rule. With `ATTACHMENT_SEARCH=true` the cron claims five a minute, newest first (`workers/store/d1/attachment-text.ts`), converts them with `toMarkdown` (text files are decoded in the Worker), drops toMarkdown's file-name heading, PDF metadata list and page headings, caps the text at 64 KB, and rewrites the message's `messages_fts` row with the text after the body. A missing file is `skipped`, a conversion error `failed`, and a claim older than 10 minutes counts as failed rather than retrying. A row whose body has no match takes its snippet from the file, after its name. `migrations/0004_attachment_trigram.sql` adds `attachment_trigram`, a contentless trigram table with one row per message holding its attachment text, written by the cron and read by the substring fallback in its own statement, so `UMC4` finds `PCAYUMC40002` inside a PDF. `tests/attachment-text.test.mjs` uses a fake R2 and converter; real `toMarkdown` was checked on localhost. | 2 days |
| 7 | Remove the old path | Delete Durable Object mail storage, the sync code, the flag and the old tests. Docs. | 1 to 2 days |

That's about four weeks of storage work plus the soak, and about three weeks of search work. S1 to S3 can run before or alongside phases 1 and 2. S4 is part of phase 2. S5 and S6 come after cutover. The estimates are rough. Phase 0 can move them in either direction.

Phase 1 ships alone with no behavior change, which makes the rest reviewable in small pieces.

## Phase 0 results

Done 2026-10-11. Details in [d1-phase0.md](d1-phase0.md); the bench is in `scripts/d1-bench/`.

| Unknown | Answer |
|---|---|
| FTS5 features | Prefix indexes, weighted `bm25`, `rank`, `snippet`, `highlight`, contentless delete, trigram, `fts5vocab`, `json_each` and `ON CONFLICT … RETURNING` all work. `sqlite_version()` is blocked. |
| Export | The full `wrangler d1 export` refuses databases with FTS5. Per-table `--table` exports work. The app ships its own export route. |
| Write speed | 1.66 ms per message for bulk import with indexes. One inbound message: about 32 ms, 1 ms of SQL, 8 rows written. |
| Batch limits | 20,000 statements fit in one batch. Payload is capped at 32 MiB per call. One value can be about 8 MB. |
| Cron | A one-minute cron ran beside `email()` and a SQLite Durable Object in one Worker. The Free plan wasn't checked. |
| Search speed | Selective searches: 0.4 to 14 ms. 10,000 matches: 21 to 44 ms. 100,000 matches: 0.22 to 0.46 s to rank, 10 to 40 ms newest first. |
| Local development | Local D1 with FTS5 and trigram works beside the remote `send_email` binding. |

What it changed in this plan: the word index stays contentless, snippets are built in the Worker, ranking counts matches first, facets are capped, statements with more than one `MATCH` are banned, the value limit is 8 MB rather than 2 MB, and batches are sized by bytes.

Phase 0 used synthetic mail with a small vocabulary, so broad-word search times are worst cases. Phase 2 repeats the search timings on a copy of real mail.

## Testing

- **Unit tests** move to the async node:sqlite `Sql`. Every test file over the index or mailbox SQL (`mail-index`, `mailbox-bulk`, `index-rows`, `label-auto`, `scheduled-send`, `send-keys`, `combined-inbox`, `folder-import`, `mail-filter`, `agent-search`) runs against the new schema. The adapter enforces the 100-parameter limit, no SQL transactions, and the 2 MB value limit.
- **Isolation test.** Every exported store function that takes a `mailboxId` is called with two mailboxes holding the same ids and subjects. It must never read or change the other mailbox's rows.
- **Miniflare end to end.** Replace the Durable Object fixture (`tests/fixtures/index-worker.ts`) with a D1 binding. Cover: inbound mail lands and is searchable; reply threading; scheduled send through `scheduled()`, including two overlapping runs sending once; a bulk job over `BULK_INLINE_LIMIT` finishing across cron runs; and a large body stored in R2 and read back.
- **Migration test.** Seed old-style Durable Objects (the current fixture), run the copy job, change mail during the copy, run catch-up, and check parity. Run the job twice to prove it is idempotent.
- **Search.**
  - A table test of the parser covers every operator, quoting, exclusion, OR, bad values and unknown operators.
  - The ranking fixture (200 messages, 30 queries with expected top results) must pass.
  - Snippet escaping is tested with hostile input.
  - The same query must give the same result from the postal view, `search_all_mail` and MCP.
  - The window's keyboard map is tested.
  - `/search/interpret` is tested with a stubbed model, including an invalid response that falls back to a word search.
- **Design rules** gain checks for the search window classes. Other UI tests don't change.

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| A query forgets `mailbox_id` and mixes addresses | Medium | The isolation test over every store function. Queries that take a mailbox go through helpers that add the filter. |
| Copy misses changes made during it | Low | Catch-up driven by the existing change sequence, then parity before cutover |
| A query hits D1's CPU limit and resets the database | Medium | Phase 0 hit it with one query shape. One `MATCH` per statement, enforced by a test. Ranking switches to newest first above 20,000 matches. |
| Snippet HTML lets mail content inject markup | Low | Escape on the server, then add marks from control characters. Hostile-input tests. |
| Plain-words search makes a wrong query | Medium | The operators it produced are shown and editable before anything runs. One call per request. |
| The search indexes grow the database | Low | Contentless word index (3.9 KB per message) and short-field trigram (0.4 KB). Body text is capped. Database size is shown on the Mail index page. |
| Cron delays scheduled send by up to a minute | Certain | Say so in the README. The UI already shows the time, not a countdown. |
| A large mailbox nears 10 GB | Low for one owner | Bodies over 512 KB in R2. Show database size on the Mail index page. Document the limit. |
| Rollback after cutover loses non-inbound changes | Low | Two-week dual inbound write. Time Travel for problems inside D1. Stated in release notes. |
| Deleting the old classes deletes data for good | Certain once run | Separate release, after the soak, behind a confirmation in the release notes |

## Decision before starting

**Before or after the public release.** Doing this before the repo is public means one deployment to move. The copy job can be a one-off script instead of a tested, documented user feature, which cuts phase 5 roughly in half. Doing it after means the first public version has the sync layer, and every early adopter has to run the copy. If the release can wait about four weeks, do it first.

## Files touched

- **New (search):** `shared/search-query.ts`, `workers/store/search.ts` (compiler, ranking, Worker-built snippets, suggest, vocab), `workers/routes/search.ts`, `app/components/postal/SearchWindow.tsx`, `tests/search-query.test.mjs`, `tests/search-ranking.test.mjs`, `tests/fixtures/search-corpus.json`
- **Changed (search):** `app/components/postal/SearchBar.tsx`, `postal.css` (`.pg-suggest`), `app/lib/mail-filter.ts`, `workers/agent/index.ts` and `workers/mcp/index.ts` (one search tool shape)
- **Deleted (search):** `MailboxDO.searchEmails`
- **New:** `migrations/0001_init.sql`, `workers/store/{types,d1,mail,labels,bulk,scheduled,send-keys,search}.ts`, `workers/cron.ts`, `workers/routes/migrate.ts` (temporary), `tests/helpers/sql.mjs`, `tests/store-isolation.test.mjs`, `tests/migrate-to-d1.test.mjs`
- **Changed:** `wrangler.jsonc`, `workers/app.ts` (cron export), `workers/index.ts`, `workers/agent/index.ts`, `workers/mcp/index.ts`, `workers/lib/{tools,email-helpers,mailbox,combined-inbox,folder-import,send,agent-model}.ts`, `workers/routes/reply-forward.ts`, `package.json` (deploy runs migrations; Drizzle driver switched to D1), `README.md`, `tests/fixtures/index-worker.ts`
- **Deleted at the end:** `workers/durableObject/index.ts`, `workers/durableObject/mail-index.ts`, `workers/durableObject/migrations.ts`, `workers/lib/{index-rows,mail-index-stub,sql-exec}.ts`, `workers/db/schema.ts`

## Drift check

2026-10-11. One pass over every claim this plan makes about the current code, at commit `ecf9412`.

Corrected:

1. **Catch-up during the copy.** The plan said the copy could replay changes from the `index_outbox` sequence. Outbox rows are deleted after each push (`workers/lib/index-rows.ts:98`), so there's nothing to replay. Fixed in phase 5: each mailbox records changes to its own `copy_outbox` while the copy runs, so index sync doesn't pause.
2. **Drizzle use.** The plan said only basic email CRUD uses Drizzle and recommended dropping it. `MailboxDO` has about 96 Drizzle references. Fixed: keep Drizzle and switch its driver to D1.
3. **Bulk job progress.** The plan said the UI already polls `bulkJob(id)`. Nothing in `app/` calls it. Fixed: on D1 every bulk action applies inline and returns its result, so there is nothing to poll. The Durable Object jobs go with phase 7.
4. **Sort options.** The plan said results sort by date only. `SORTS` is date, sender and subject. The point stands: there's no relevance order. Fixed the wording.
5. **Operator values.** The `in:` example used `anywhere`, which the value list didn't name. Today's `has:unsubscribe` and the views `unread` and `starred` were missing. Fixed: each operator row marks today's values and the new ones.

Confirmed as written:
- Durable Object tables per class.
- R2 keys.
- The 11 files that call storage.
- `transactionSync` call sites.
- `/api/v1/index/status`.
- `BULK_INLINE_LIMIT` (500).
- The two search engines: the classic view uses `parseSearchQuery` and per-mailbox `searchEmails`. The agent's and MCP's `search_emails` use `searchEmails` with `LIKE`.
- The two parsers.
- `buildMatch` AND-prefix matching.
- Contentless `messages_fts` and its columns.
- `BODY_TEXT_LIMIT` (32 KB).
- The search window's empty-only display and the 720px cap.
- `saved_searches` with no API or UI.
- Cursors carry the conversation's address (`thread_key`).
- Scheduled sends show their time in the list.
- The test files the plan names exist.

Second pass, after phase 0 (2026-10-11):

6. The ranking threshold, the CPU-limit rule and the ranking times were corrected to match the phase 0 output. See the drift check in [d1-phase0.md](d1-phase0.md#drift-check).

