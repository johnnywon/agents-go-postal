# Setup

Everything needed to run Agents Go Postal on your own Cloudflare account. Back to the [README](../README.md).

## Deploy with the button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/johnnywon/agents-go-postal)

The button copies this repo to your GitHub account, creates the R2 bucket and Durable Objects, builds and deploys. Its form asks for `DOMAINS` but has no field for `EMAIL_ADDRESSES`. It also saves the placeholder values from `.dev.vars.example` as the `POLICY_AUD` and `TEAM_DOMAIN` secrets, so every request returns the "Access must be configured" error until step 5 replaces them. Then:

1. In the new repo, set `EMAIL_ADDRESSES` in `wrangler.jsonc` to the addresses you want, and push. The push builds and deploys again. Every address must belong to a domain in `DOMAINS`.
2. Do steps 5 to 8 below: Access, Email Routing, Email Sending, and the check.

The Worker answers on its workers.dev URL until you add a custom domain (step 4 under Deploy by hand).

## Deploy by hand

Requirements: a domain on Cloudflare, R2, and Workers Paid for outbound email. The `email` commands below need Wrangler 4.149 or later, so they run through `npx wrangler@latest`.

1. **Install and sign in.** `npm install`, then `npx wrangler login`.
2. **Configure `wrangler.jsonc`.** Set `name`, `account_id`, `vars.APP_NAME`, `vars.DOMAINS`, and `vars.EMAIL_ADDRESSES`. Every address must belong to a domain in `DOMAINS`.
3. **Create the R2 bucket** named in `r2_buckets`: `npx wrangler r2 bucket create agents-go-postal`
4. **Deploy.** `npm run build && npm run deploy`. `npm run deploy` only deploys, and refuses to run before a build. Until step 5 is done, every request returns an error asking for Access. To serve the app on your own hostname, uncomment `routes` in `wrangler.jsonc` and set the `pattern`, or add a custom domain under the Worker's Settings > Domains & Routes.
5. **Turn on Cloudflare Access** for the Worker under Settings > Domains & Routes ([one-click Access](https://developers.cloudflare.com/changelog/post/2025-10-03-one-click-access-for-workers/)). Copy the values the modal shows into Worker secrets:
   ```sh
   npx wrangler secret put POLICY_AUD
   npx wrangler secret put TEAM_DOMAIN
   ```
   `TEAM_DOMAIN` may be the team URL or the full `/cdn-cgi/access/certs` URL.
6. **Route mail to the Worker.** Enable Email Routing for the domain, then add one rule per address in `EMAIL_ADDRESSES`:
   ```sh
   npx wrangler@latest email routing enable example.com
   npx wrangler@latest email routing rules create example.com \
     --match-type literal --match-field to --match-value hello@example.com \
     --action-type worker --action-value agents-go-postal
   ```
   `email routing enable` adds and locks Cloudflare MX records at the root of the domain. If that domain already receives mail elsewhere, such as Google Workspace, use a subdomain instead: add it under Email Routing > Settings > Subdomains in the dashboard, since Wrangler only enables whole domains. Rules for subdomain addresses are created on the parent domain.
7. **Enable Email Sending** so the Worker can send replies. Cloudflare adds the SPF, DKIM and DMARC records:
   ```sh
   npx wrangler@latest email sending enable example.com
   ```
   This works for a subdomain too, for example `mail.example.com`.
8. **Check it.** `npm run smoke` expects every request to redirect to the Access login. It reads the hostname from `routes`; without one, run `SMOKE_URL=https://<your worker URL> npm run smoke`. Then send a message to one of your addresses. A configured address gets its mailbox on first delivery, so mail is kept even if nobody has opened the app yet.

### Troubleshooting Access

- `Invalid or expired Access token`: `POLICY_AUD` or `TEAM_DOMAIN` is wrong. Turn Access off and on for the Worker to see the values again, then reset both secrets.
- `Cloudflare Access must be configured in production`: the secrets are missing. The Worker fails closed on purpose.

## Configuration

| Setting | Where | Purpose |
| --- | --- | --- |
| `APP_NAME` | `vars` | Name in the header, status bar and page titles |
| `DOMAINS` | `vars` | Comma-separated domains that receive mail |
| `EMAIL_ADDRESSES` | `vars` | Addresses that get a mailbox. Mail to other addresses is rejected. |
| `INDEX_SYNC_ENABLED` | `vars` | `false` pauses updates to the combined index; changes queue in each mailbox |
| `AUTO_DRAFT_ENABLED` | `vars` | `true` drafts a reply to each new message, except list, bulk and automated mail |
| `ATTACHMENT_SEARCH` | `vars` | `true` makes attachment text searchable (D1 only). Uses one Workers AI `toMarkdown` call per PDF, Word or Excel file. |
| `POLICY_AUD`, `TEAM_DOMAIN` | secrets | Cloudflare Access verification |

To rebrand a deployment, set `APP_NAME` and replace the files listed in [`public/brand/README.md`](../public/brand/README.md).

## Moving to D1

Mail is stored in one Durable Object per address, with a combined index in another. D1 storage keeps everything in one database instead. It is being built now ([d1-migration-plan.md](d1-migration-plan.md)); new deployments don't need it yet.

To move a deployment that already holds mail:

1. Create a D1 database, bind it as `DB` in your wrangler config with `"migrations_dir": "migrations"`, and run `npx wrangler d1 migrations apply <database> --remote`. Deploy. Nothing changes yet.
2. Open Settings, then Storage, and press Copy to D1. The copy runs a slice every minute from the cron. Mail stays where it is and the app keeps working. Changes made during the copy are copied again.
3. When the page says the counts match, set `"STORAGE": "d1"` in `vars` and deploy. The first cron run after that makes a last pass, then D1 is the only store. The page says when it's done. A new cron trigger can take half an hour to start firing, so add the D1 binding and deploy (step 1) well before you switch.

Pick a quiet hour for step 3. A change made on the old store in the minute before the deploy can overwrite the same message's change on D1 in the minute after it.

Run `npx wrangler d1 migrations apply <database> --remote` before deploying a new version: new code writes columns that later migrations add (`0002_has_link.sql` adds `has_link`; `0003_attachment_text.sql` queues older attachments for `ATTACHMENT_SEARCH`; `0004_attachment_trigram.sql` adds substring search over their text). A search that finds no substring table fails, so apply `0004` before deploying a version that has it. Adding a column doesn't break the version already running.

For two weeks after the switch, new inbound mail is also written to the old store. To move back, remove `STORAGE` and deploy. Mail received in those two weeks comes back with it. Read state, labels, moves, sends and scheduled sends made on D1 do not, and mail scheduled before the switch stays in Drafts unscheduled. Problems inside D1 itself are better fixed with Time Travel (`wrangler d1 time-travel`).

## Keeping a deployment in its own repo

A deployment can keep its config and brand files outside this checkout, for example in a private repo that includes this one as a submodule. Build with:

```sh
AGP_WRANGLER_CONFIG=../wrangler.jsonc AGP_PUBLIC_DIR=../public npm run build
npx wrangler deploy
```

`AGP_WRANGLER_CONFIG` replaces `wrangler.jsonc`. Paths inside it, such as `main`, are relative to that file. `AGP_PUBLIC_DIR` replaces `public/`, so it must hold the full set of brand files. `wrangler deploy` then uses the config the build wrote to `build/server/`.
