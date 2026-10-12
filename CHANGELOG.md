# Changelog

Versions follow [semantic versioning](https://semver.org). Before 1.0, a minor version can break things. Each entry names any new D1 migration: apply it with `wrangler d1 migrations apply <db> --remote` before you deploy that version.

## 0.1.4

- Settings > Model & key is rewritten. The agent runs on Cloudflare (Workers AI) in your own account, or on OpenRouter held to zero data retention; nothing else can be connected. A notice at the top of the tab says why: the agent reads your mail, so a model that keeps or trains on it is a security risk. Each provider's line says what its own policy states and links to it; Cloudflare's says it makes no zero retention promise. A search-interpret log line no longer records the model's reply text. Catalog reads time out after 10 s and show an error instead of leaving the tab loading.
- OpenRouter lists only models with a zero retention endpoint, priced at the cheapest one, and every request sends `provider: { zdr: true, data_collection: "deny" }`, so a model with no such endpoint fails instead of falling back. Free models are left out of every list and refused as typed ids. Cloudflare lists only priced text models that aren't partner models; a typed id outside that list is refused on save and test. Anthropic, OpenAI, Google and xAI models are filters on OpenRouter.
- The tab shows the agent model, a line on what happens to prompts there, and the two providers with their status and key. Change model opens a picker: a search, four suggested models as cards, one per need (Recommended: Kimi K2.6 and Cheapest: GLM 5.3 Flash on Cloudflare; Balanced: Claude Sonnet 5.5 and Best quality: Claude Opus 5.5 on OpenRouter), and rows to browse each provider and maker. Rows show name, provider and maker, context and price per million tokens in aligned columns, sorted by suggestion, price or context.
- Any paid model id can be used: type it in the search and choose Use. Models a catalog marks as unable to call tools are tagged, not hidden.
- `config/agent-model.json` now holds `{ selected, keys }`. The older OpenRouter-only file is read as before. `GET /api/v1/agent-model/catalog` replaces `/models` and `/workers-ai-models`; `PUT /api/v1/agent-model` takes `{ selected, keys }`.

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
