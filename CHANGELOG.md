# Changelog

Versions follow [semantic versioning](https://semver.org). Before 1.0, a minor version can break things. Each entry names any new D1 migration: apply it with `wrangler d1 migrations apply <db> --remote` before you deploy that version.

## 0.3.0

- Settings > Model & key is rewritten. The agent runs on Cloudflare (Workers AI) in your own account, or on OpenRouter held to zero data retention; nothing else can be connected. A notice at the top of the tab says why: the agent reads your mail, so a model that keeps or trains on it is a security risk. Each provider's line says what its own policy states and links to it; Cloudflare's says it makes no zero retention promise. A search-interpret log line no longer records the model's reply text. Catalog reads time out after 10 s and show an error instead of leaving the tab loading.
- OpenRouter lists only models with a zero retention endpoint, priced at the cheapest one, and every request sends `provider: { zdr: true, data_collection: "deny" }`, so a model with no such endpoint fails instead of falling back. Free models are left out of every list and refused as typed ids. Cloudflare lists only priced text models that aren't partner models; a typed id outside that list is refused on save and test. Anthropic, OpenAI, Google and xAI models are filters on OpenRouter.
- The tab shows the agent model, a line on what happens to prompts there, and the two providers with their status and key. Change model opens a picker: a search, four suggested models as cards, one per need (Recommended: Kimi K2.6 and Cheapest: GLM 5.3 Flash on Cloudflare; Balanced: Claude Sonnet 5.5 and Best quality: Claude Opus 5.5 on OpenRouter), and rows to browse each provider and maker. Rows show name, provider and maker, context and price per million tokens in aligned columns, sorted by suggestion, price or context.
- Any paid model id can be used: type it in the search and choose Use. Models a catalog marks as unable to call tools are tagged, not hidden.
- The prompt injection check runs on `@cf/meta/llama-3.1-8b-instruct-fp8`. Cloudflare deprecated `llama-3.1-8b-instruct-fast`, which it used. An empty or unclear answer from the check now skips auto-draft, the same as an error; before, it let the email through.
- `config/agent-model.json` now holds `{ selected, keys }`. The older OpenRouter-only file is read as before. `GET /api/v1/agent-model/catalog` replaces `/models` and `/workers-ai-models`; `PUT /api/v1/agent-model` takes `{ selected, keys }`.
- The README roadmap is reordered: a faster start now (one-command setup, mail import, starting on Workers Free), agent control next (scoped access, an approval queue with an activity log, rules in plain words), then shared inboxes, Queue events, search by meaning and offline. Model choice moves to Shipped.
- The README is half as long. It states the version and where the project stands up top, and a Before you deploy section lists what you can rely on and what to know first: Email Sending is in public beta, agents can send without an approval step, and there's no export, IMAP or SMTP yet. Version and CI badges. The mail flow diagrams and developer notes move to `docs/architecture.md`, and the full roadmap to `docs/roadmap.md`.

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
