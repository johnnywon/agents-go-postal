# Changelog

Versions follow [semantic versioning](https://semver.org). Before 1.0, a minor version can break things. Each entry names any new D1 migration: apply it with `wrangler d1 migrations apply <db> --remote` before you deploy that version.

## 0.1.3

- Settings holds everything: the Labels page and the Mail index page are now the Labels and Storage tabs of the Settings dialog. `/settings` and `/settings/index` redirect there. The open tab is in the URL (`?settings=labels`), and Back closes the dialog. Storage shows per-address counts on D1 and the index comparison and Rebuild on Durable Objects.
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
