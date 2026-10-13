# Changelog

Versions follow [semantic versioning](https://semver.org). Before 1.0, a minor version can break things. Each entry names any new D1 migration. `npm run deploy` applies it; if you deploy another way, run `wrangler d1 migrations apply DB --remote` before you deploy that version.

## 0.7.6

Demo build: `OMR_DEMO=1` builds a read-only instance filled with sample mail.

- `OMR_DEMO=1 npm run build` makes a demo build. On its first API request it writes the sample inbox (about 470 messages, 62 attachments, 12 labels, 3 saved searches) into an empty database, with the newest message minutes old. A normal build carries none of it.
- A demo sends nothing, calls no model and needs no sign-in. Send, reply, forward and scheduled send return 403. The Mailroom agent, Draft, redraft, search interpretation, auto-draft and the MCP server are off, and their controls are hidden. Settings are read-only. Incoming mail is rejected. Cloudflare Access is skipped.
- Visitors can read, search, archive, delete, star, label and save drafts. The cron writes the sample inbox again every hour on the hour, over everything visitors changed.
- `GET /api/v1/config` returns `demo`.
- `npm run test:build` builds both ways and checks that only the demo build carries the sample inbox. CI runs it in place of `npm run build`.
- The dev server's sample inbox (`workers/lib/dev-seed/`) is new in this release; [Sample inbox](docs/development.md#sample-inbox) describes it.
- `SEED_PROFILE=alex` picks a second sample inbox: Alex Rivera, who runs a catalog API, across seven mailboxes and 47 messages, with a late-night incident and its recovery, invoices, a payout, food orders and a fantasy league. Four openly licensed photos show inline; PDFs, CSVs, text files and JPEGs are real attachments. Links open an in-app page (`/api/v1/sample-link`) instead of leaving the app. [Alex profile](docs/demo-alex.md) lists every message.
- A seeded reply draft now opens under the message it answers.

Decided for the demo: build it and show it locally first, then host it as its own deploy repo. The demo is open to anyone, without Access. See [Demo build](docs/setup.md#demo-build).

No D1 migration.

## 0.7.4

The reader.

- Every message is a page with one left edge, lined up with the subject, sender and Reply bar. Plain mail no longer floats indented on the reader background.
- Plain mail reads in a serif at 16px with lines capped at 66 characters, so the message reads as a letter and the app stays sans. Designed HTML mail keeps its own fonts on its white page.
- Text-only mail: blank-line runs collapse to one paragraph break, bare URLs and addresses are links, the signature under a `-- ` line is muted under a rule, and quoted replies (`>` lines and "On … wrote:") fold behind a toggle.
- A text body with an address in angle brackets ("<jane@example.com>") was shown as HTML. Only real tags count now.
- Images hidden is a row at the top of the message instead of a bar above it. A blocked image shows its alt text in a dashed box instead of the broken-image icon, and tracking pixels are dropped.
- The agent panel and its collapsed rail are labelled MAILROOM AGENT, and the sidebar MAILROOM.
- The list header reads which addresses, then which folder: the address picker as its mark and a caret, then the folder with the same icon it has in the sidebar. The scope's icon used to sit beside the folder name as if they were one control. Click the folder name to jump to a sibling: the same list the sidebar shows under that address, or under All addresses with its labels. Switching address keeps the folder you are in.
- The message frame skips writing a document it already holds. Two writes in a row, as React makes in development, left plain mail blank in some Chromium browsers.
- In a small window the reader slid under the agent rail, so MAILROOM AGENT sat on top of the toolbar and the sender's address was cut to "<". The reader now shrinks, its toolbar wraps and the sender line breaks.
- Who sent a message and when is now the page's letterhead: name and address over the receiving address on the left, the date over the time on the right, above a hairline. The initial square and the angle brackets are gone.
- Labels are no longer chips. In the reader they sit on a thin rail across the top of the message, right-aligned over the date; in the list they are tags beside the star, with the name on hover, so a labelled row is no taller than any other.
- Quoted earlier messages in HTML replies fold behind the `···` toggle, as in text-only mail. Opened, each one sits under a hairline with its sender and date instead of a grey block.
- Focused search lifts off the page: a soft shadow on both sides of the bar and its window.
- When the agent drafted more than once in one auto-draft run, every draft stayed in Drafts. The run now keeps its last draft and discards the earlier ones (#19).

No D1 migration.

## 0.7.3

The last fixes from the 0.7.0 review.

- Console > Overview showed at most 5 failed actions, and 0 when the failures were older than the newest 50 actions. It now shows the day's real count. `GET /api/v1/agents/overview` returns it as `failed`.
- Auto-draft: a draft saved from the model's text, without a `draft_reply` call, was missing from Console > Activity. It is now logged as `draft_reply`.
- Auto-draft: when the model called `draft_reply` more than once and newer mail superseded the run, only the last draft was discarded. Every draft from that run is discarded now.
- A redraft you ask for in the app was logged as the chat agent. It is now logged as you, with its own "You" filter in Console > Activity.
- The send routes (`POST /api/v1/mailboxes/:id/emails`, reply and forward) now return the attempt's state and provider ID with a 409, as 0.7.0 said they did.
- A failed idempotency key used again kept its first-use time, so it could be pruned hours later and a retry would send a second copy. Using it again now starts a new 7 days.
- Console: `?console=constructor` and other built-in property names opened an empty Console. Save checked the limits only after the address and prefs writes had started, so an invalid limit left the other changes saved. It now checks first and saves nothing. The Drafting tab's Sending line shows the saved limits, not unsaved edits.

No D1 migration.

## 0.7.2

More fixes from the 0.7.0 review.

- A send whose caller died before delivery started left its key pending for 7 days, so every retry of that draft got 409. A pending attempt older than 5 minutes can now be claimed again.
- A send error marked the attempt failed even when the message may have gone out (a timeout or an internal error), so a scheduled send could be delivered twice. Now only an error code that proves the mail service refused the message marks it failed and gives back the send limit slot. Any other error leaves the attempt in sending with the error saved, a deferred send keeps its Sent copy, and the cron stops retrying that scheduled send.
- Auto-draft: when the worker running a draft died, the queue's redelivery acked the message and the run stayed running with no draft. The redelivery now retries once the run can be taken over, and the hourly cron marks failed any run still running after an hour.
- Redraft: typing in the body while a redraft ran lost the edit and left a stray draft. The body is now read-only and autosave waits until the redraft returns. Keys typed meanwhile stay in the composer instead of triggering mail shortcuts.

No D1 migration.

## 0.7.1

Fixes from a review of 0.7.0.

- A send from the app or the API that failed at the mail service was marked sent. A retry with the same idempotency key returned the first send and nothing went out. Now the attempt stays in sending until delivery finishes. A failed delivery marks the key failed, gives back the send limit slot and moves the message from Sent to Drafts.
- Console > Limits: clearing a field saved 0, which stopped agent sending or auto-drafting. A limit must now be a whole number. Save sends only the limits you changed, the fields wait for the saved values to load, and `PUT /api/v1/agent-limits` returns an error instead of saving over defaults when it can't read the saved file.
- Auto-draft: when the model call after `draft_reply` failed, the queue retried and drafted the same reply again. A run with a saved draft now counts as drafted.

No D1 migration.

## 0.7.0

Agent reliability.

- **Send attempts.** An idempotency key now tracks its send through pending, sending, sent or failed. The mail service's message ID is saved before the Sent copy. Reusing a key for a different message returns 409. A send that reached the mail service but wasn't stored returns 409 with its state and provider ID instead of sending again. A key whose send failed before delivery can be used again.
- **Console.** The sidebar's Settings and MCP buttons are now one Console button. The Agents group has Overview, Activity, Limits, Drafting (the old Agent tab), Model & key, and Connections (the old MCP dialog); the Settings group has the rest. Links use `?console=<tab>`; `?settings=` links still open the matching tab.
- **Send limits.** Console > Limits sets agent sends a day per address (default 20, 0 stops agent sending), recipients per agent message (default 10, at most 50) and auto-drafts per sender a day (default 3). Saved in R2 at `config/agent-limits.json`; `GET` and `PUT /api/v1/agent-limits`. No agent or MCP tool can change them. People keep the fixed 20 an hour, 100 a day and 50 recipients. These now count sends, not Sent mail, and the check and count are atomic. A send that never reached the mail service doesn't count. Console > Overview (`GET /api/v1/agents/overview`) shows each address's sends against the limits.
- **Auto-draft runs.** Each new message gets a run row. Newer mail in the thread supersedes an unfinished run, and a draft from a superseded run is discarded. Each sender gets 3 auto-drafts per address a day by default. An optional `DRAFT_QUEUE` queue retries a failed draft three times with backoff and then dead-letters it; see [Auto-draft queue](docs/setup.md#auto-draft-queue). Without the queue each draft is tried once, as before.
- **Activity log.** Every tool call by the chat agent, auto-draft and MCP clients is logged with the address, target, a summary and the MCP client's name. Console > Activity lists and filters it; prefs `activityDays` keeps 90 (default), 120 or 180 days, pruned hourly by the cron. `GET /api/v1/activity`, `GET /api/v1/auto-draft/runs`.
- **Redraft.** An agent draft shows who wrote it and takes a one-off instruction ("shorter") that rewrites it. Instructions are kept with the draft. `POST /api/v1/mailboxes/:id/drafts/:draftId/redraft`.
- A deploy config that supplies its own `queues` can bind `DRAFT_QUEUE` with `max_retries: 3`; nothing else in the config changes.

D1 migration: `0006_agent_reliability.sql`. `npm run deploy` applies it. Deploy this version only after the migration: sends write the new `send_budget` table.

## 0.6.0

Durable Object mail storage removed.

- **Breaking:** mail is stored only in D1. A deployment still on `"STORAGE": "do"` must move to D1 on 0.5.x first ([Moving to D1 in the v0.5.1 docs](https://github.com/johnnywon/open-mailroom/blob/v0.5.1/docs/setup.md#moving-to-d1)). 0.6 adds the `v5` Durable Object migration with `deleted_classes: ["MailboxDO", "MailIndexDO"]`, which deletes the mail still in them when it deploys.
- A deploy config that supplies its own `migrations` must append `{ "tag": "v5", "deleted_classes": ["MailboxDO", "MailIndexDO"] }` and drop the `MAILBOX` and `MAIL_INDEX` bindings.
- Removed: the `STORAGE` and `INDEX_SYNC_ENABLED` vars, the `MAILBOX` and `MAIL_INDEX` bindings, the copy to D1 with its cron step and `/api/v1/admin/migrate-to-d1` routes, and `/api/v1/index/status` and `/api/v1/index/rebuild`. The Storage tab's counts come from `/api/v1/storage/status`.
- The R2 `mailboxes/*.json` records are no longer read; D1's `mailboxes` table has held mailbox settings since 0.5. They can be deleted from the bucket.
- Removed the `drizzle-orm` dependency.

D1 migration: `0005_drop_copy_job.sql`. `npm run deploy` applies it.

## 0.5.1

- `npm run deploy` applies D1 migrations with the config in `OMR_WRANGLER_CONFIG`. In 0.5.0 it read the repo's example `wrangler.jsonc`, so a deployment with its own config stopped at the migration step and nothing deployed. With more than one Cloudflare account, set `CLOUDFLARE_ACCOUNT_ID`; `wrangler d1` does not read `account_id` from the config.

No D1 migration.

## 0.5.0

D1 by default.

- A new deployment stores mail in D1. `wrangler.jsonc` binds a `DB` database and sets `"STORAGE": "d1"`. The Deploy to Cloudflare button creates the database; by hand, run `npx wrangler d1 create open-mailroom` and copy the id into `d1_databases`.
- **Upgrading a deployment that still stores mail in Durable Objects:** set `"STORAGE": "do"` in `vars` before you deploy 0.5.0, or the app opens on an empty D1 database. Nothing is lost; setting `do` and deploying brings the mail back. Then move with [Moving to D1](https://github.com/johnnywon/open-mailroom/blob/v0.5.1/docs/setup.md#moving-to-d1). The Durable Object store is removed in 0.6.
- `npm run deploy` applies D1 migrations before it deploys.
- Each address has its own agent prompt. Settings > Agent edits one address at a time, with "Use for every address" to copy one. Draft reply and auto-draft use their address's prompt; the chat panel uses the prompt of the address whose mail is open, or the default when nothing is open.
- The deploy button's form asks for `EMAIL_ADDRESSES` and explains the Access placeholders. `EMAIL_ADDRESSES` can be a list or a comma-separated string.
- Removed: the `AGP_WRANGLER_CONFIG` and `AGP_PUBLIC_DIR` build vars (use `OMR_*`), the copy of `agp-*` browser prefs (a browser last opened before 0.4.0 starts with default prefs), the pre-0.3.0 agent model file shape (pick the model again in Settings > Model & key), the `/mailbox/...` and `/settings` redirects, and the cron that filled `has_link` on older D1 mail. A D1 deployment that applied `0002_has_link.sql` before 0.5.0 has had a minute per 200 messages to fill it; check with `SELECT count(*) FROM messages WHERE has_link IS NULL`.
- Removed dead code: the `MAIL_UI` leftovers, `formatEmailDate`, and the phase 0 D1 bench.

No D1 migration.

## 0.4.2

- Incoming messages with a duplicate Message-ID are skipped, and failed saves clean up attachment files.
- Mail to an address this deployment doesn't handle now bounces back to the sender instead of being dropped silently.
- Outbound subjects and threading headers reject line breaks.
- Responses add frame protections and safer attachment headers; `/mcp` refuses foreign origins.
- Cloudflare Access reuses its JWKS, requires RS256 and an HTTPS `TEAM_DOMAIN`.
- Mailbox settings are validated before they are saved.

No D1 migration.

## 0.4.1

Agent safety.

- Auto-draft gets three tools: `get_email`, `get_thread` and `draft_reply`. Before, it had the chat agent's full set, including label, move, discard and shortcut tools and `draft_email` to any address. `get_thread` reads only the new email's thread, `get_email` only emails in it, and `draft_reply` answers the new email with the recipient fixed to its Reply-To, else its sender. The chat agent keeps its tools.
- The agent panel no longer loads images from markdown in the agent's replies. An image shows as a link that opens when clicked.
- Inbound mail joins a thread only when its In-Reply-To or References names a message stored in that mailbox. Before, the first References entry became the thread id as sent. With no such header, a message joins by subject only when the subject starts with a reply prefix such as `Re:`, the thread had mail in the last two days, and the sender sent mail in it or was written to from the mailbox. Otherwise it starts its own thread. Both stores match the same way.
- The prompt injection check covers everything auto-draft shows the model: sender, display name, recipient, subject and the full body of every message in the thread, in overlapping chunks. Before, it read the body and 500 characters of each earlier message. `get_email` and `get_thread` return that scanned copy. A detected injection, an unclear answer, a failed check, a thread too long to check or a failed read skips the draft; the reason is logged and shown in the agent panel.

No D1 migration.

## 0.4.0

- The project is now Open Mailroom. The repo moved to github.com/johnnywon/open-mailroom; the old URL redirects.
- The logo is gone from the sidebar, the empty reader and error pages. The app icon stays. The link preview card shows the mark without a name.
- Build env vars are `OMR_WRANGLER_CONFIG` and `OMR_PUBLIC_DIR`. `AGP_*` still work.
- Browser prefs move from `agp-*` to `omr-*` keys on first load. Nothing to do.
- The default worker and R2 bucket names in `wrangler.jsonc` are `open-mailroom`. An existing deployment keeps its own names; don't change them, or Cloudflare creates a new worker and an empty bucket.
- README screenshots reshot, with light versions for readers on a light theme.

No D1 migration.

## 0.3.0

- Settings > Model & key is rewritten. The agent runs on Cloudflare (Workers AI) in your own account, or on OpenRouter held to zero data retention; nothing else can be connected. A notice at the top of the tab says why: the agent reads your mail, so a model that keeps or trains on it is a security risk. Each provider's line says what its own policy states and links to it; Cloudflare's says it makes no zero retention promise. A search-interpret log line no longer records the model's reply text. Catalog reads time out after 10 s and show an error instead of leaving the tab loading.
- OpenRouter lists only models with a zero retention endpoint, priced at the cheapest one, and every request sends `provider: { zdr: true, data_collection: "deny" }`, so a model with no such endpoint fails instead of falling back. Free models are left out of every list and refused as typed ids. Cloudflare lists only priced text models that aren't partner models; a typed id outside that list is refused on save and test. Anthropic, OpenAI, Google and xAI models are filters on OpenRouter.
- The tab shows the agent model, a line on what happens to prompts there, and the two providers with their status and key. Change model opens a picker: a search, four suggested models as cards, one per need (Recommended: Kimi K2.6 and Cheapest: GLM 5.3 Flash on Cloudflare; Balanced: Claude Sonnet 5.5 and Best quality: Claude Opus 5.5 on OpenRouter), and rows to browse each provider and maker. Rows show name, provider and maker, context and price per million tokens in aligned columns, sorted by suggestion, price or context.
- A model id not in the lists can be typed in the search and used if its provider allows it: on Cloudflare a priced model that isn't a partner model, on OpenRouter a paid model with a zero retention endpoint. A `:free` id is refused in any case, and a free model saved by an older version is dropped so the recommended model runs. Models a catalog marks as unable to call tools are tagged, not hidden.
- The prompt injection check runs on `@cf/meta/llama-3.1-8b-instruct-fp8`. Cloudflare deprecated `llama-3.1-8b-instruct-fast`, which it used. An empty or unclear answer from the check now skips auto-draft, the same as an error; before, it let the email through.
- `config/agent-model.json` now holds `{ selected, keys }`. The older OpenRouter-only file is read as before. `GET /api/v1/agent-model/catalog` replaces `/models` and `/workers-ai-models`; `PUT /api/v1/agent-model` takes `{ selected, keys }`.
- The README roadmap is reordered: a faster start now (one-command setup, mail import, starting on Workers Free), agent control next (scoped access, an approval queue with an activity log, rules in plain words), then shared inboxes, Queue events, search by meaning and offline. Model choice moves to Shipped.
- The README is half as long. It states the version and where the project stands up top, and a Before you deploy section lists what you can rely on and what to know first: Email Sending is in public beta, agents can send without an approval step, and there's no export, IMAP or SMTP yet. Version and CI badges. The mail flow diagrams and developer notes move to `docs/architecture.md`, and the full roadmap to `docs/roadmap.md`. The approval queue and scoped agent access move up to Now.

No D1 migration.

## 0.2.0

- Keyboard shortcuts are one system. `shared/shortcuts.ts` defines every shortcut once; the mail view's key handler, tooltips, key hints and the new lists read it, so a hint can't name a key that does nothing.
- Press `?` for a map of the mail view drawn like the real one: the sidebar with its Go to keys and `⌘B` on its collapse button, J and K above and below the open conversation, each toolbar key under its button's icon, `⌘J` on the agent's collapse button. Keys pressed all day are drawn larger. The map is built from the registry, so a new shortcut places itself.
- Settings has a Shortcuts tab listing every shortcut by group, where each mail-view shortcut can be rebound: click its keys, press the new one. A key already in use moves over. Rebound keys are saved with the other prefs in `config/prefs.json` (`shortcuts`).
- Report spam: `!`, a button after Trash in the reader toolbar, and one in the bulk bar. It moves the conversation to Spam, with Undo.
- A keyboard button at the foot of the sidebar opens the map. In Settings > Shortcuts, × turns a shortcut off. Keys the browser keeps (`⌘T`, `⌘W`, `⌘R`, copy and paste, zoom, tab switching) can't be bound.
- When shortcuts change somewhere else (the agent, MCP, another browser), a toast says what changed ("Archive is now Y") with Undo, once per browser.
- The agent and MCP can rebind shortcuts: `list_shortcuts`, `set_shortcut` (keys as text such as `"y"`, `"shift+y"`, `"cmd+k"`) and `reset_shortcuts`. The app refreshes its keys when the agent's turn ends.
- Adding a shortcut is one registry entry plus its action; `shared/shortcuts.ts` and `CLAUDE.md` say how.
- Shortcuts follow Gmail: `#` trash (and Outlook's `Delete`), `!` report spam, `s` star, `⇧I` mark read, `⇧U` mark unread, `l` label, `u` back, and `g` then `s`, `d`, `t` or `a` for Starred, Drafts, Sent and All mail. `` ` `` steps through Inbox, Unread, Starred and Drafts, and `~` steps back, as Gmail does with inbox sections. `⌘B` toggles the sidebar, `⌘J` the agent panel and `\` both.
- Shortcuts work while focus is inside a message, including `Shift+x`, `⌘J` and `?`. The message frame used to pass up a fixed list of keys, some with no shortcut behind them.
- Off a Mac, hints show `Ctrl` instead of `⌘`.
- The empty list's "Clear search" button no longer shows the `G I` hint, which goes to the Inbox.
- Settings > General's "Show keyboard shortcuts" is now "Show key hints".

No D1 migration.

## 0.1.3

- Settings holds everything: the Labels page and the Mail index page are now the Labels and Storage tabs of the Settings dialog. `/settings` and `/settings/index` redirect there. The open tab is in the URL (`?settings=labels`), and Back closes the dialog. Storage shows per-address counts on D1 and the index comparison and Rebuild on Durable Objects.
- Settings > General (theme, key hints, mark as read, remote images, reply from) is saved to the deployment in R2 (`config/prefs.json`) and follows you to every browser. The first browser to load this version uploads its own settings. `GET` and `PUT /api/v1/prefs`.
- Dividers are straight: anything with a border on one side only (rows, headers, footers, table cells, the side columns) has square corners. A design test keeps it that way.
- Switches are pills: a 36 by 20 track with a 14px knob inset 3px.
- Settings > Model & key lists Workers AI models with context size and price per million tokens, read live from Cloudflare's catalog (`env.AI.models()`) and limited to models that can call tools. Search and sort (cheapest, most context) the list; five are suggested. Each row has a maker tag, a context bar and a price chip coloured by cost. The pick is saved as `workersAiModel` in `config/agent-model.json`; leaving it on the recommended model follows future defaults. `GET /api/v1/agent-model/workers-ai-models`.
- The default agent model is `@cf/moonshotai/kimi-k2.6`. Cloudflare no longer lists `kimi-k2.5`. A saved model that Cloudflare stops listing falls back to the default.
- A signature with text no longer shows the "No signature" placeholder over it.
- The brushed-metal settings styles, `SettingsHeader`, `DeckBrand` and the Oxanium font are gone.

No D1 migration.

## 0.1.2

- Unknown paths answer HTTP 404 instead of 200.
- Error pages (404, crashes, Access errors in a browser) use the mail view's look and theme instead of the settings shell, Kumo's empty state or plain text. API clients still get plain text.

No D1 migration.

## 0.1.1

- CI: tests, typecheck and build run on every pull request and every push to `main`.
- `package.json` carries the version.

## 0.1.0

First tagged version, at `465b00b`. One list for every address, labels and bulk actions with undo, scheduled send, the in-app agent, the MCP server, one search language with ranked results, D1 storage with attachment search, Move to Inbox and Empty Trash.

D1 migrations: `0001` to `0004`.
