# Changelog

Versions follow [semantic versioning](https://semver.org). Before 1.0, a minor version can break things. Each entry names any new D1 migration: apply it with `wrangler d1 migrations apply <db> --remote` before you deploy that version.

## 0.1.4

- Settings > Model & key is rewritten for five providers: Cloudflare (Workers AI), OpenRouter, Anthropic, OpenAI and xAI. The tab shows the agent model and the providers, each with its connection status and key; Change model opens a picker: a search over every provider's models, the suggested models, and a row per provider to browse its full list. Rows show the name, provider and maker, context size and price per million tokens in aligned columns, sorted by suggestion, price or context. Colour is kept to meaning: a provider's square, green for the chosen model, yellow for a missing key. Anthropic, OpenAI and xAI list their own models with your key and take prices from OpenRouter's catalog.
- Any model id can be used: type it in the search and choose Use. Models a catalog marks as unable to call tools are tagged, not hidden. Test works for every provider.
- `config/agent-model.json` now holds `{ selected, keys }`, one key per provider. The older OpenRouter-only file is read as before. `GET /api/v1/agent-model/catalog` replaces `/models` and `/workers-ai-models`; `PUT /api/v1/agent-model` takes `{ selected, keys }`.
- New dependencies: `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/xai`.

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
