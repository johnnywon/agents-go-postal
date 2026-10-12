# Open Mailroom

Self-hosted multi-address email on Cloudflare Workers. React Router v7 UI in `app/`, Worker backend in `workers/`, shared code in `shared/`.

## Run and check

- `npm run dev:local` with a gitignored `wrangler.local.jsonc` (see README, Local development). Seed sample mail with `POST /api/v1/dev/seed`.
- `npm test`, `npm run typecheck`, `npm run build` before every commit.
- Browser QA: open the dev server and check the console, at desktop and 375px widths.

## Design

`DESIGN.md` is the design system. `tests/design-rules.test.mjs` enforces the checkable rules (single 6px radius, no accent stripes or edge bars). The mail view lives in `app/components/postal/` with its styles in `postal.css`. The settings pages' tokens and surfaces are in `app/index.css`.

## Keyboard shortcuts

Every shortcut lives in `shared/shortcuts.ts`; nothing else names a key. To add one: an entry in `SHORTCUTS` (id, group, label, keys, scope, `area` for the ? map, `primary` for an all-day key), its action in the `actions` map in `PostalMail.tsx` (typecheck fails without it), and a button title from `useShortcuts().tip(id, label)`. `tests/shortcuts.test.mjs` checks defaults don't clash. Users and agents rebind keys at runtime through prefs (`shortcuts`), Settings > Shortcuts, or the `set_shortcut` tool.

## Rules

- This repo is generic and will be public. Never commit a real domain, address, account ID, worker name or brand from any deployment. Use `example.com`, `example.org` and `example.net` in config, docs and tests.
- Deployments supply their own config and brand with `OMR_WRANGLER_CONFIG` and `OMR_PUBLIC_DIR`. Brand art is only in `public/`.
- Durable Object class names and migration tags are permanent. Migrations are append-only.
