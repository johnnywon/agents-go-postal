# Development

Back to the [README](../README.md).

## Local development

```sh
npm install
npx wrangler login
cp .dev.vars.example .dev.vars
npx wrangler d1 migrations apply DB --local
npm run dev
```

Set `account_id` in `wrangler.jsonc` first. Local development still connects to your Cloudflare account: Workers AI always runs remotely and may incur charges, and the `send_email` binding is remote. Access checks are skipped in development.

To keep your account ID and test addresses out of `wrangler.jsonc`, copy it to `wrangler.local.jsonc` (gitignored), edit that copy, and run `npm run dev:local`. Apply the migrations with `-c wrangler.local.jsonc`.

Mail is stored in a local D1 database under `.wrangler/state`. Run the migrations command again after pulling a new migration. To run on the Durable Object store instead, set `"STORAGE": "do"`.

Open the app once so it creates the configured mailboxes, then fill them with sample mail:

```sh
curl -X POST http://localhost:5173/api/v1/dev/seed \
  -H 'content-type: application/json' -H 'sec-fetch-site: same-origin' \
  -d '{"perMailbox": 15}'
```

The seed route exists only in development builds.

`vite.config.ts` pre-bundles the UI libraries so the first page load after a fresh start works. If a new dependency brings back "Invalid hook call" on a first load, the dev log names it under "new dependencies optimized": add it to `PREBUNDLE`.

To test inbound mail locally, post a raw message to the dev server's email handler:

```sh
curl -X POST 'http://localhost:5173/cdn-cgi/handler/email?from=sender@example.net&to=hello@example.com' \
  --data-binary @message.eml
```

## Checks

```sh
npm test
npm run typecheck
npm run build
```

Design rules live in [`DESIGN.md`](../DESIGN.md). `tests/design-rules.test.mjs` enforces the ones that can be checked.
