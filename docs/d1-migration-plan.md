# Plan: move mail storage to D1

Status: proposal. Nothing here is built yet.

## Summary

Mail now lives in one Durable Object per address (`MailboxDO`) plus one combined index (`MailIndexDO`). This plan replaces both with one D1 database. The chat agent and MCP server stay Durable Objects; they hold chat history, not mail.

Why:

- **One copy of the data.** The per-address objects are the source of truth and the index is a derived copy kept in sync by an outbox, retries, a rebuild job and a parity page. With D1 every query reads the same tables, and that sync layer is deleted.
- **Users can see and keep their data.** D1 has a SQL console in the dashboard, `wrangler d1 execute`, and Time Travel restore to any minute in the last 30 days. Durable Object storage has none of these for a self-hoster.
- **Contributors know it.** Plain SQL migration files instead of migrations that run inside each object, and no permanent class names to protect.
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

The draft below is the first migration. `id` columns stay text UUIDs so existing ids, URLs and R2 attachment paths survive the copy. FTS needs an integer rowid, so `messages` has both.

```sql
-- migrations/0001_init.sql
CREATE TABLE mailboxes (
	id TEXT PRIMARY KEY,                -- the address, lowercase
	settings TEXT NOT NULL DEFAULT '{}', -- JSON, was mailboxes/<address>.json
	created_at TEXT NOT NULL
);

CREATE TABLE folders (
	mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
	id TEXT NOT NULL,
	name TEXT NOT NULL,
	is_deletable INTEGER NOT NULL DEFAULT 1,
	PRIMARY KEY (mailbox_id, id),
	UNIQUE (mailbox_id, name)
);

CREATE TABLE messages (
	rowid INTEGER PRIMARY KEY,           -- FTS rowid
	id TEXT NOT NULL UNIQUE,             -- was emails.id
	mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
	folder_id TEXT NOT NULL,
	thread_id TEXT NOT NULL,
	message_id TEXT,                     -- RFC Message-ID
	in_reply_to TEXT,
	email_references TEXT,               -- JSON array
	date TEXT NOT NULL,
	subject TEXT NOT NULL DEFAULT '',
	subject_norm TEXT NOT NULL DEFAULT '',
	sender TEXT NOT NULL DEFAULT '',
	sender_name TEXT NOT NULL DEFAULT '',
	sender_domain TEXT NOT NULL DEFAULT '',
	recipient TEXT NOT NULL DEFAULT '',
	cc TEXT,
	bcc TEXT,
	snippet TEXT NOT NULL DEFAULT '',
	body TEXT,                           -- NULL when body_key is set
	body_key TEXT,                       -- R2 key for bodies over BODY_INLINE_MAX
	raw_headers TEXT,
	read INTEGER NOT NULL DEFAULT 0,
	starred INTEGER NOT NULL DEFAULT 0,
	has_attachment INTEGER NOT NULL DEFAULT 0,
	list_id TEXT,
	unsubscribe TEXT,
	FOREIGN KEY (mailbox_id, folder_id) REFERENCES folders(mailbox_id, id)
);
CREATE INDEX messages_folder_date ON messages (mailbox_id, folder_id, date DESC);
CREATE INDEX messages_date ON messages (date DESC);
CREATE INDEX messages_thread ON messages (mailbox_id, thread_id);
CREATE INDEX messages_message_id ON messages (message_id);
CREATE INDEX messages_in_reply_to ON messages (in_reply_to);
CREATE INDEX messages_sender ON messages (sender);
CREATE INDEX messages_sender_domain ON messages (sender_domain);

CREATE VIRTUAL TABLE messages_fts USING fts5(
	subject, sender_name, sender, recipient, body_text,
	content='', contentless_delete=1,
	tokenize='unicode61 remove_diacritics 2', prefix='2 3'
);

CREATE TABLE attachments (
	id TEXT PRIMARY KEY,
	message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
	filename TEXT NOT NULL,
	mimetype TEXT NOT NULL,
	size INTEGER NOT NULL,
	content_id TEXT,
	disposition TEXT
);
CREATE INDEX attachments_message ON attachments (message_id);

CREATE TABLE labels (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL UNIQUE,
	color TEXT NOT NULL,
	position INTEGER NOT NULL DEFAULT 0,
	auto_applied_at TEXT                 -- was label_auto
);
CREATE TABLE message_labels (
	message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
	label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
	PRIMARY KEY (message_id, label_id)
);
CREATE INDEX message_labels_label ON message_labels (label_id);

CREATE TABLE saved_searches (
	id TEXT PRIMARY KEY, name TEXT NOT NULL, filter TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE scheduled_sends (
	message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE, -- the draft
	mailbox_id TEXT NOT NULL,
	send_at TEXT NOT NULL,
	payload TEXT NOT NULL,
	attempts INTEGER NOT NULL DEFAULT 0,
	error TEXT,
	claimed_at TEXT                      -- set by the cron run that is sending it
);
CREATE INDEX scheduled_sends_due ON scheduled_sends (send_at) WHERE attempts < 3;

CREATE TABLE send_keys (
	mailbox_id TEXT NOT NULL,
	key TEXT NOT NULL,
	state TEXT NOT NULL,                 -- pending | sent
	message_id TEXT,
	created_at TEXT NOT NULL,
	PRIMARY KEY (mailbox_id, key)
);
CREATE INDEX send_keys_created ON send_keys (created_at);

CREATE TABLE undo (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE bulk_jobs (
	id TEXT PRIMARY KEY, created_at TEXT NOT NULL, action TEXT NOT NULL, ops TEXT NOT NULL,
	position INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL, affected INTEGER NOT NULL DEFAULT 0,
	failed TEXT NOT NULL DEFAULT '[]', undo_id TEXT NOT NULL, finished_at TEXT
);
```

Notes:

- `state` in the index (`inbox`, `sent`, `folder:<id>`) becomes `folder_id` plus a computed expression. `folderToState` stays as a SQL `CASE`, or the query builder filters on `folder_id` directly.
- `thread_key` (address + separator + conversation) becomes the pair `(mailbox_id, thread_id)`. Cursors and the UI's `open=` parameter already carry the address, so URLs keep working.
- Tombstones, `generation`, `seq`, `mailbox_cursor`, `rebuild_job` and `index_outbox` have no equivalent. They exist only to keep the copy in sync.

### Bodies over the row limit

D1 refuses rows and strings over 2 MB. Some HTML mail is bigger than that. Bodies over `BODY_INLINE_MAX` (512 KB) go to R2 at `bodies/<message id>.html`, with `body_key` set and `body` NULL. `snippet` and the FTS row are built from the full body before it is stored, so search still covers it. `getEmail` reads R2 when `body_key` is set.

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

- `workers/store/d1.ts` wraps `env.DB` (`prepare().bind().all()`, `env.DB.batch()`).
- `tests/helpers/sqlite.mjs` gains an async `Sql` over node:sqlite with the same D1 limits it enforces today: at most 100 bound parameters, no SQL-level transactions, plus a 2 MB value check. Unit tests stay in node and stay fast.
- Id lists use `json_each(?)` with one JSON parameter instead of `IN (?, ?, ...)`, which removes the 100-parameter ceiling from bulk actions.

The modules that hold SQL (`mail-index-sql.ts`, `mail-bulk-sql.ts`, `mailbox-bulk.ts`, `scheduled-send.ts`, `send-keys.ts`, `index-rows.ts`, the `MailboxDO` methods) move to `workers/store/` as async functions over `Sql`. Most of the change is mechanical: `exec(` becomes `await sql.all(`. The functions listed under "Places that rely on `transactionSync`" get rewritten:

| Operation | D1 form |
|---|---|
| Claim a send key | `INSERT INTO send_keys ... ON CONFLICT DO NOTHING RETURNING state`. If nothing comes back, `SELECT` the existing row. One writer, so there is no race. |
| Take an undo entry | `DELETE FROM undo WHERE id = ? RETURNING payload` |
| Mark labels auto | `UPDATE labels SET auto_applied_at = ? WHERE id IN (SELECT value FROM json_each(?)) RETURNING id` |
| Delete a label | `batch([DELETE message_labels..., DELETE labels...])`, or rely on `ON DELETE CASCADE` |
| Create a message | `batch([INSERT messages, INSERT messages_fts, INSERT attachments...])`. The FTS insert uses `last_insert_rowid()`, or `RETURNING rowid` followed by a second batch. |
| Bulk step | One `UPDATE ... WHERE id IN (SELECT value FROM json_each(?))` per chunk |

Drizzle (`drizzle-orm/durable-sqlite` in `MailboxDO`) is replaced by `drizzle-orm/d1` or dropped. Only the basic email CRUD uses it; the rest is raw SQL. Dropping it removes a dependency and keeps one style. Recommendation: drop it.

### Jobs that used alarms

| Job | Now | After |
|---|---|---|
| Scheduled send | `MailboxDO` alarm at the exact time | Cron Trigger `* * * * *` runs `runDueScheduled`. A row is claimed with `UPDATE scheduled_sends SET claimed_at = ? WHERE message_id = ? AND claimed_at IS NULL RETURNING ...`, so two overlapping cron runs can't both send it. The `draft:<id>` send key is the second guard. Claims older than 10 minutes are released. |
| Index push retries | `MailboxDO` alarm | Deleted |
| Index rebuild | `MailIndexDO` alarm | Deleted. A "Reindex search" admin action replaces it: it rebuilds `messages_fts` from `messages` in chunks. |
| Large bulk actions (over `BULK_INLINE_LIMIT`) | `MailIndexDO` alarm | The request runs the first chunk. The same cron runs the rest of `bulk_jobs` in chunks of 1,000. The UI already polls `bulkJob(id)`. |
| Old send keys, undo rows | Pruned on use | Same, plus a daily sweep in the cron |

This adds no new Cloudflare product: one D1 binding and one cron.

### What stays per address

Each address keeps its own folders, threads, rate limit (now `WHERE mailbox_id = ? AND folder_id = 'sent'`), send keys, signature, display name and agent prompt. Per-address isolation becomes a column instead of a separate database. Every query that takes a mailbox must filter on `mailbox_id`, and tests check that (see Testing).

### Configuration

```jsonc
"d1_databases": [
	{ "binding": "DB", "database_name": "agents-go-postal", "database_id": "<set by deploy>", "migrations_dir": "migrations" }
],
"triggers": { "crons": ["* * * * *"] }
```

- `npm run deploy` runs `wrangler d1 migrations apply DB --remote` before `wrangler deploy`.
- The Deploy to Cloudflare button provisions D1 and applies migrations, as it does for cf-mailroom.
- `INDEX_SYNC_ENABLED` is removed.
- During the transition, a `STORAGE` var takes `do` or `d1` (see Rollout). It is removed in the last phase.
- Durable Object migrations are append-only. Removing the classes is a new tag with `deleted_classes: ["MailboxDO", "MailIndexDO"]`, applied only after the data is copied and the rollback window has passed. It permanently deletes their storage.

## Moving existing deployments

Every deployment that already holds mail needs a one-time copy. It runs inside the Worker, so it reads Durable Object storage directly and writes D1 through the binding.

1. **Export methods on the old classes.**
   - `MailboxDO.exportPage({ afterId, limit })` returns full rows: emails with bodies, attachments metadata, `email_labels`, folders, `scheduled_sends` and `send_keys`.
   - `MailboxDO.changedSince(seq)` returns ids changed after a sequence number. It reuses the existing `index_outbox` sequence, which already records every change in order.
   - `MailIndexDO.exportGlobals()` returns `labels`, `label_auto` and `saved_searches`.
2. **The copy job.** `POST /api/v1/admin/migrate-to-d1` with `{ confirm: true }` starts it. A `migration_job` row in D1 tracks progress, and the cron advances it.
   - First it records each mailbox's current `seq`.
   - Then it copies mailbox settings from R2, the global tables, and every mailbox page by page, 200 messages per batch, using `INSERT OR IGNORE`. Large bodies go to R2.
   - The job is resumable and idempotent: rerunning it skips rows already copied.
3. **Catch-up.** After the full copy, each mailbox replays `changedSince(recorded seq)`, re-copying those rows with `INSERT OR REPLACE` and deleting rows that no longer exist. This repeats until a pass finds nothing.
4. **Check.** A parity report compares per-mailbox, per-folder counts, unread counts, label counts and scheduled-send counts between the old storage and D1. The current `/api/v1/index/status` parity page is reused for this.
5. **Cut over.**
   - Set `STORAGE=d1` and deploy. All reads and writes go to D1 from that point.
   - Run a final catch-up for the seconds between the last pass and the deploy.
   - The old classes keep their data and are no longer written.
6. **Rollback window (two weeks).**
   - During it, inbound mail is also written to the old `MailboxDO`, so mail received after cutover is not lost if storage has to move back.
   - Other changes made after cutover (read state, labels, moves, sends) are not written back. A rollback loses them. The README says so.
   - Problems inside D1 itself are fixed with Time Travel, not by rolling back.
7. **Remove.** Delete the dual write, the `STORAGE` flag, the export methods, the old classes (with the `deleted_classes` migration) and `INDEX_SYNC_ENABLED`.

The copy job is a user-facing feature of one release, so it needs its own README section and a button on the Mail index settings page. The button shows progress and the parity result.

## Phases

| # | Phase | Output | Rough size |
|---|---|---|---|
| 0 | Checks | Short notes on the unknowns listed below, each answered in a throwaway Worker against real D1 | 1 to 2 days |
| 1 | Access layer | `Sql` interface, the D1 and node:sqlite adapters, and SQL modules moved to `workers/store/` as async functions. The Durable Objects call the async versions through an adapter, so behavior doesn't change and every test still passes. | 3 to 4 days |
| 2 | D1 schema and store | `migrations/0001_init.sql` and a `MailStore` built on D1 with the same methods the routes, tools and agent use today. Tests run against it. | 4 to 5 days |
| 3 | Switch callers | The 11 files call `MailStore` instead of stubs. The `STORAGE` var picks the Durable Object store or the D1 store. `MAIL_UI` modes all read through it. | 2 to 3 days |
| 4 | Jobs | The cron handler: scheduled send with claims, bulk job chunks, sweeps. Large bodies in R2. Reindex search. | 2 days |
| 5 | Copy job | Export methods, the copy and catch-up job, the parity report, the settings page button, dual inbound writes | 3 to 4 days |
| 6 | Move your own deployment | Copy, check, cut over, two-week soak. Fix what it turns up. | 2 weeks elapsed, about 1 day of work |
| 7 | Remove the old path | Delete Durable Object mail storage, the sync code, the flag and the old tests. Docs. | 1 to 2 days |

That's about four weeks of work plus the soak. The estimates are rough. Phase 0 can move them in either direction.

Phase 1 ships alone with no behavior change, which makes the rest reviewable in small pieces.

## Unknowns to settle in phase 0

1. **FTS5 options.** Check that D1 accepts `contentless_delete=1` (needs SQLite 3.43 or later) and the `prefix` option. If not, use an external-content table (`content='messages'` with a stored `body_text` column) and accept the extra storage.
2. **Export with virtual tables.** `wrangler d1 export` has refused databases that contain virtual tables. If that is still true, ship our own export: `GET /api/v1/export` as JSON lines plus attachment and body keys in R2. Users need a "get my mail out" path anyway.
3. **Write throughput.** Time the import of 100,000 messages in batches of 200, and the cost of one inbound message (message, FTS row and attachments in one batch). Write the per-message cost into the README.
4. **Batch size limits.** Measure the largest statement count and payload one `batch()` accepts, so import and bulk chunk sizes are set from data.
5. **Cron on the plans users run.** Check that a one-minute cron is allowed and that `scheduled()` and `email()` can live in the same Worker with the Agents SDK's Durable Objects.
6. **Local development.** `wrangler dev` with a local D1, migrations applied by `npm run dev:local`, and the seed route writing to it. Check that the remote `send_email` binding still works alongside it.

## Testing

- **Unit tests** move to the async node:sqlite `Sql`. Every test file over the index or mailbox SQL (`mail-index`, `mailbox-bulk`, `index-rows`, `label-auto`, `scheduled-send`, `send-keys`, `combined-inbox`, `folder-import`, `mail-filter`, `agent-search`) runs against the new schema. The adapter enforces the 100-parameter limit, no SQL transactions, and the 2 MB value limit.
- **Isolation test.** Every exported store function that takes a `mailboxId` is called with two mailboxes holding the same ids and subjects. It must never read or change the other mailbox's rows.
- **Miniflare end to end.** Replace the Durable Object fixture (`tests/fixtures/index-worker.ts`) with a D1 binding. Cover: inbound mail lands and is searchable; reply threading; scheduled send through `scheduled()`, including two overlapping runs sending once; a bulk job over `BULK_INLINE_LIMIT` finishing across cron runs; and a large body stored in R2 and read back.
- **Migration test.** Seed old-style Durable Objects (the current fixture), run the copy job, change mail during the copy, run catch-up, and check parity. Run the job twice to prove it is idempotent.
- **Design rules and UI tests** don't change.

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| A query forgets `mailbox_id` and mixes addresses | Medium | The isolation test over every store function. Queries that take a mailbox go through helpers that add the filter. |
| Copy misses changes made during it | Low | Catch-up driven by the existing change sequence, then parity before cutover |
| FTS option unsupported on D1 | Medium | Phase 0, item 1. External-content fallback. |
| Cron delays scheduled send by up to a minute | Certain | Say so in the README. The UI already shows the time, not a countdown. |
| A large mailbox nears 10 GB | Low for one owner | Bodies over 512 KB in R2. Show database size on the Mail index page. Document the limit. |
| Rollback after cutover loses non-inbound changes | Low | Two-week dual inbound write. Time Travel for problems inside D1. Stated in release notes. |
| Deleting the old classes deletes data for good | Certain once run | Separate release, after the soak, behind a confirmation in the release notes |

## Decision before starting

**Before or after the public release.** Doing this before the repo is public means one deployment to move. The copy job can be a one-off script instead of a tested, documented user feature, which cuts phase 5 roughly in half. Doing it after means the first public version has the sync layer, and every early adopter has to run the copy. If the release can wait about four weeks, do it first.

## Files touched

- **New:** `migrations/0001_init.sql`, `workers/store/{types,d1,mail,labels,bulk,scheduled,send-keys,search}.ts`, `workers/cron.ts`, `workers/routes/migrate.ts` (temporary), `tests/helpers/sql.mjs`, `tests/store-isolation.test.mjs`, `tests/migrate-to-d1.test.mjs`
- **Changed:** `wrangler.jsonc`, `workers/app.ts` (cron export), `workers/index.ts`, `workers/agent/index.ts`, `workers/mcp/index.ts`, `workers/lib/{tools,email-helpers,mailbox,combined-inbox,folder-import,send,agent-model}.ts`, `workers/routes/reply-forward.ts`, `package.json` (deploy runs migrations; Drizzle removed), `README.md`, `tests/fixtures/index-worker.ts`
- **Deleted at the end:** `workers/durableObject/index.ts`, `workers/durableObject/mail-index.ts`, `workers/durableObject/migrations.ts`, `workers/lib/{index-rows,mail-index-stub,sql-exec}.ts`, `workers/db/schema.ts`
