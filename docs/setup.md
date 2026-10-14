# Setup

Everything needed to run Open Mailroom on your own Cloudflare account. Back to the [README](../README.md).

## Deploy with the button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/johnnywon/open-mailroom)

The button copies this repo to your GitHub account, creates the R2 bucket, the D1 database and the Durable Objects, then builds, applies the D1 migrations and deploys. Its form asks for `DOMAINS` and `EMAIL_ADDRESSES`. Enter the addresses comma-separated; every address must belong to a domain in `DOMAINS`. Leave the `POLICY_AUD` and `TEAM_DOMAIN` placeholders: every request returns the "Access must be configured" error until step 5 below replaces them. Then do steps 5 to 8 below: Access, Email Routing, Email Sending, and the check.

To change the addresses later, edit `EMAIL_ADDRESSES` in `wrangler.jsonc` in the new repo and push. The push builds and deploys again.

The Worker answers on its workers.dev URL until you add a custom domain (step 4 under Deploy by hand).

## Deploy by hand

Requirements: a domain on Cloudflare, R2, and Workers Paid for outbound email. The `email` commands below need Wrangler 4.149 or later, so they run through `npx wrangler@latest`.

1. **Install and sign in.** `npm install`, then `npx wrangler login`.
2. **Configure `wrangler.jsonc`.** Set `name`, `account_id`, `vars.APP_NAME`, `vars.DOMAINS`, and `vars.EMAIL_ADDRESSES`. Every address must belong to a domain in `DOMAINS`.
3. **Create the R2 bucket and the D1 database** named in `r2_buckets` and `d1_databases`:
   ```sh
   npx wrangler r2 bucket create open-mailroom
   npx wrangler d1 create open-mailroom
   ```
   Copy the `database_id` that `d1 create` prints into the `DB` entry under `d1_databases`.
4. **Deploy.** `npm run build && npm run deploy`. `npm run deploy` applies any new D1 migrations, then deploys. It refuses to run before a build. Until step 5 is done, every request returns an error asking for Access. To serve the app on your own hostname, uncomment `routes` in `wrangler.jsonc` and set the `pattern`, or add a custom domain under the Worker's Settings > Domains & Routes.
5. **Turn on Cloudflare Access** for the Worker under Settings > Domains & Routes ([one-click Access](https://developers.cloudflare.com/changelog/post/2025-10-03-one-click-access-for-workers/)). Copy the values the modal shows into Worker secrets:
   ```sh
   npx wrangler secret put POLICY_AUD
   npx wrangler secret put TEAM_DOMAIN
   ```
   `TEAM_DOMAIN` must include `https://`; use the team URL or the full `/cdn-cgi/access/certs` URL.
6. **Route mail to the Worker.** Enable Email Routing for the domain, then add one rule per address in `EMAIL_ADDRESSES`:
   ```sh
   npx wrangler@latest email routing enable example.com
   npx wrangler@latest email routing rules create example.com \
     --match-type literal --match-field to --match-value hello@example.com \
     --action-type worker --action-value open-mailroom
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
- `POLICY_AUD is missing`, `TEAM_DOMAIN is missing`, or `TEAM_DOMAIN must be an https:// URL`: correct the missing or malformed secret. The Worker fails closed on purpose.

## Configuration

| Setting | Where | Purpose |
| --- | --- | --- |
| `APP_NAME` | `vars` | Name in the header, status bar and page titles |
| `DOMAINS` | `vars` | Comma-separated domains that receive mail |
| `EMAIL_ADDRESSES` | `vars` | Addresses that get a mailbox, as a list or a comma-separated string. Mail to other addresses bounces. |
| `AUTO_DRAFT_ENABLED` | `vars` | `true` drafts a reply to each new message, except list, bulk and automated mail |
| `ATTACHMENT_SEARCH` | `vars` | `true` makes attachment text searchable. Uses one Workers AI `toMarkdown` call per PDF, Word or Excel file. |
| `POLICY_AUD`, `TEAM_DOMAIN` | secrets | Cloudflare Access verification |

To rebrand a deployment, set `APP_NAME` and replace the files listed in [`public/brand/README.md`](../public/brand/README.md).

## Auto-draft queue

With `AUTO_DRAFT_ENABLED` on, a queue retries a draft that failed, for example on a model timeout. It is optional: without it each draft is tried once.

```bash
npx wrangler queues create open-mailroom-drafts
npx wrangler queues create open-mailroom-drafts-dlq
```

Then uncomment `queues` in `wrangler.jsonc` and deploy. Keep `max_retries` at 3. Messages that fail every retry wait in `open-mailroom-drafts-dlq`, and their runs show as Failed in Console > Activity.

## D1 migrations

`npm run deploy` applies new D1 migrations before it deploys. If you deploy another way, run `npx wrangler d1 migrations apply DB --remote` first: new code writes columns that later migrations add (`0002_has_link.sql` adds `has_link`; `0003_attachment_text.sql` queues older attachments for `ATTACHMENT_SEARCH`; `0004_attachment_trigram.sql` adds substring search over their text; `0005_drop_copy_job.sql` drops the tables of the copy from Durable Objects; `0006_agent_reliability.sql` adds send attempts, send limits, auto-draft runs, the activity log and draft notes). A search that finds no substring table fails, so apply `0004` before deploying a version that has it. Adding a column doesn't break the version already running.

## Upgrading from Durable Object storage

Before 0.5, mail was stored in one Durable Object per address, with a combined index in another. 0.6 deletes that storage and the mail in it. A deployment still on it (`"STORAGE": "do"`) must upgrade to 0.5.x first, copy its mail to D1 ([Moving to D1 in the v0.5.1 docs](https://github.com/johnnywon/open-mailroom/blob/v0.5.1/docs/setup.md#moving-to-d1)) and switch to `"STORAGE": "d1"`, then install 0.6.

## Demo build

A demo build comes up filled with the [sample inbox](development.md#sample-inbox) on an empty, migrated database, so you can show the app without real mail. Anyone who opens it can read, search, file, label, star, delete and save drafts.

```sh
OMR_DEMO=1 npm run build
npm run deploy
```

`OMR_DEMO=1` is read at build time. A build without it carries none of the sample inbox or the demo code. A demo build:

- Sends nothing. Send, reply, forward and scheduled send return 403 `Sending is off in the demo`. The cron sends no scheduled mail. Incoming mail is rejected.
- Calls no model. The Mailroom agent, its panel, Draft and Draft reply, redraft, search interpretation and auto-draft are off. `/agents/*` and `/mcp` return 403.
- Keeps settings read-only. Console > Save, addresses, model, limits and prefs return 403 `Settings are read-only in the demo`. Any other write not on the demo's list is refused the same way (`workers/lib/demo.ts`).
- Needs no sign-in. It skips Cloudflare Access, so `POLICY_AUD` and `TEAM_DOMAIN` are not needed and Log out is hidden. `npm run smoke` expects an Access redirect and fails against a demo.
- Writes the sample inbox again every hour on the hour. The reset deletes all mail, files, labels, saved searches and undo history, then writes the sample inbox with fresh dates. Between resets, a new isolate moves the dates forward when the newest message is over 30 minutes old.

Sample times follow the time zone of the machine that ran the build.

Give a demo its own Worker, D1 database and R2 bucket. Its Wrangler config keeps the cron trigger (the hourly reset runs on it) and leaves out `send_email` and `ai`, so no real send or model call can happen even if the demo gate were bypassed. Set `EMAIL_ADDRESSES` to six addresses named `hello`, `billing`, `support`, `legal`, `ops` and `press` so every part of the sample inbox has its own mailbox. Run it locally with `OMR_DEMO=1 npm run build && npx vite preview` against a migrated local database.

For the [Alex profile](demo-alex.md), set `SEED_PROFILE` to `alex` in the demo's `vars`, `EMAIL_ADDRESSES` to its nine addresses (`hello`, `support`, `billing`, `partners` and `ops` at `partwell.dev`, `alex` and `league` at `alexrivera.me`, `booking@latecommits.band` and `alex@riverbendcode.org`) and `DOMAINS` to `partwell.dev,alexrivera.me,latecommits.band,riverbendcode.org`. Its times are New York times on any machine, and links in its mail open a page in the app instead of leaving it.

## Keeping a deployment in its own repo

A deployment can keep its config and brand files outside this checkout, for example in a private repo that includes this one as a submodule. Build with:

```sh
OMR_WRANGLER_CONFIG=../wrangler.jsonc OMR_PUBLIC_DIR=../public npm run build
npm run deploy
```

`OMR_WRANGLER_CONFIG` replaces `wrangler.jsonc`. Paths inside it, such as `main` and the D1 `migrations_dir`, are relative to that file; with this repo as `engine/`, that is `"migrations_dir": "engine/migrations"`. `OMR_PUBLIC_DIR` replaces `public/`, so it must hold the full set of brand files. `npm run deploy` then applies D1 migrations and deploys with the config the build wrote to `build/server/`.
