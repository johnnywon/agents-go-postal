# Agents Go Postal

Self-hosted email for several addresses and domains, with an AI agent, running on your own Cloudflare account.

Mail arrives through Cloudflare Email Routing. Each address gets its own Durable Object with SQLite storage, and attachments go to R2. A mail index combines every address into one list, so the address is a filter rather than a separate inbox. The agent reads, searches and drafts replies. It never sends without a click.

Derived from [cloudflare/agentic-inbox](https://github.com/cloudflare/agentic-inbox). See `NOTICE`.

## Features

- **One list for every address.** Filter by address, domain, sender, label, date and status. Each domain gets its own colour and shape, so you can tell at a glance which address a message reached.
- **Full mail client.** Rich-text compose, reply, reply all, forward, drafts, attachments, folders, stars, search and message source view.
- **One composer.** New mail, replies and forwards share the same layout. Replies and forwards quote the original as HTML, with its styles and scripts removed.
- **Signatures.** One per address, set in Settings > Signatures. None is added unless you turn on "Add by default"; the signature button in the composer adds or removes it on any message.
- **Scheduled send.** Pick tomorrow morning, Monday morning or any future time. The message waits in Drafts until it goes out.
- **Labels and bulk actions.** Select many conversations to archive, delete, mark read, star, label or move. Undo is available after each action.
- **Keyboard shortcuts** for navigation and actions.
- **Per-address isolation.** Every address has its own Durable Object, database and prompt settings.
- **AI agent.** A side panel that can read, search, label and draft using Workers AI, or any OpenRouter model with your own key. It searches and labels across every address at once (`search_all_mail`, `label_matching`, up to 500 conversations per call). "Draft with agent" in either composer asks it for a first draft. Labels the agent has applied are marked with a sparkle. Automatic drafting of new mail is off by default (`AUTO_DRAFT_ENABLED`).
- **MCP server** for connecting outside agents.
- **Cloudflare Access required.** Outside local development the Worker refuses every request until Access is configured.

## Stack

- **Frontend:** React 19, React Router v7 (server rendered), Tailwind CSS, TanStack Query, Zustand, TipTap, `@cloudflare/kumo`
- **Backend:** Hono, Cloudflare Workers, Durable Objects (SQLite), R2, Email Routing, Email Sending
- **Agent:** Cloudflare Agents SDK, AI SDK v6, Workers AI or OpenRouter
- **Auth:** Cloudflare Access JWT validation

## Setup

Requirements: a domain on Cloudflare, R2, and Workers Paid for outbound email. The `email` commands below need Wrangler 4.149 or later, so they run through `npx wrangler@latest`.

1. **Install and sign in.** `npm install`, then `npx wrangler login`.
2. **Configure `wrangler.jsonc`.** Set `name`, `account_id`, `vars.APP_NAME`, `vars.DOMAINS`, `vars.EMAIL_ADDRESSES` and the route `pattern`. Every address must belong to a domain in `DOMAINS`.
3. **Create the R2 bucket** named in `r2_buckets`: `npx wrangler r2 bucket create agents-go-postal`
4. **Deploy.** `npm run deploy`. Until step 5 is done, every request returns an error asking for Access.
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
8. **Check it.** `npm run smoke` expects every request to redirect to the Access login. Then send a message to one of your addresses. A configured address gets its mailbox on first delivery, so mail is kept even if nobody has opened the app yet.

### Troubleshooting Access

- `Invalid or expired Access token`: `POLICY_AUD` or `TEAM_DOMAIN` is wrong. Turn Access off and on for the Worker to see the values again, then reset both secrets.
- `Cloudflare Access must be configured in production`: the secrets are missing. The Worker fails closed on purpose.

## Configuration

| Setting | Where | Purpose |
| --- | --- | --- |
| `APP_NAME` | `vars` | Name in the header, status bar and page titles |
| `DOMAINS` | `vars` | Comma-separated domains that receive mail |
| `EMAIL_ADDRESSES` | `vars` | Addresses that get a mailbox. Mail to other addresses is rejected. |
| `MAIL_UI` | `vars` | `postal` (default) for the current view, `unified` for the earlier one-list view, `classic` for the per-mailbox routes. Unset means `classic`. |
| `INDEX_SYNC_ENABLED` | `vars` | `false` pauses updates to the combined index; changes queue in each mailbox |
| `AUTO_DRAFT_ENABLED` | `vars` | `true` drafts a reply to each new message |
| `POLICY_AUD`, `TEAM_DOMAIN` | secrets | Cloudflare Access verification |

To rebrand a deployment, set `APP_NAME` and replace the files listed in `public/brand/README.md`.

### The postal view

`MAIL_UI=postal` is a three-column workspace: mailboxes on the left, the list and reader in the middle, the agent on the right. Both side columns collapse to rails. Below 1300px the agent overlays the reader; at phone widths the app shows one pane at a time.

Preferences such as theme (dark, light or system), key hints, mark-as-read, remote images and reply-from-receiving-address are stored per browser. Display names and the agent prompt are stored with each mailbox.

Keyboard: `j`/`k` move, `e` archive, `x` select, `r` reply, `a` reply all, `f` forward, `c` new email, `z` undo, `/` or `⌘K` search, `⌘↵` send, `⌘J` agent, `Esc` close.

### Scheduled send

Choose a time from the arrow next to Send in the compose window. The message is saved to Drafts with a "Scheduled" badge, and the address's Durable Object sends it with an alarm at that time through the normal sending path. Cancel removes the schedule and keeps the draft. Editing or deleting the draft before the send time cancels it. A send that fails is retried every 15 minutes, up to three attempts; after that the draft stays in Drafts marked "Send failed". Attachments count toward a 1.5 MB limit per scheduled message.

### Agent model

The agent runs on Workers AI (`@cf/moonshotai/kimi-k2.5`) by default. To use OpenRouter instead, open Settings, then Model & key, choose OpenRouter, paste an API key and pick a model. Only models that can call tools are listed. Test sends one short prompt to check the key. The chat panel, "Draft with agent" and auto-draft then use that model and bill your OpenRouter account. The prompt-injection check and the draft cleanup on incoming mail stay on Workers AI.

The key is stored in R2 at `config/agent-model.json`, which no route serves. The API returns only its last four characters. Anyone who can open the app can replace or remove it, so keep the app behind Access.

### Keeping a deployment in its own repo

A deployment can keep its config and brand files outside this checkout, for example in a private repo that includes this one as a submodule. Build with:

```sh
AGP_WRANGLER_CONFIG=../wrangler.jsonc AGP_PUBLIC_DIR=../public npm run build
npx wrangler deploy
```

`AGP_WRANGLER_CONFIG` replaces `wrangler.jsonc`. Paths inside it, such as `main`, are relative to that file. `AGP_PUBLIC_DIR` replaces `public/`, so it must hold the full set of brand files. `wrangler deploy` then uses the config the build wrote to `build/server/`.

## Local development

```sh
npm install
npx wrangler login
cp .dev.vars.example .dev.vars
npm run dev
```

Set `account_id` in `wrangler.jsonc` first. Local development still connects to your Cloudflare account: Workers AI always runs remotely and may incur charges, and the `send_email` binding is remote. Access checks are skipped in development.

To keep your account ID and test addresses out of `wrangler.jsonc`, copy it to `wrangler.local.jsonc` (gitignored), edit that copy, and run `npm run dev:local`.

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

Design rules live in `DESIGN.md`. `tests/design-rules.test.mjs` enforces the ones that can be checked.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
