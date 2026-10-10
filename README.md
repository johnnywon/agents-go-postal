# Agents Go Postal

Self-hosted email for several addresses and domains, with an AI agent, running on your own Cloudflare account.

Mail arrives through Cloudflare Email Routing. Each address gets its own Durable Object with SQLite storage, and attachments go to R2. A mail index combines every address into one list, so the address is a filter rather than a separate inbox. The agent reads, searches and drafts replies. It never sends without a click.

Derived from [cloudflare/agentic-inbox](https://github.com/cloudflare/agentic-inbox). See `NOTICE`.

## Features

- **One list for every address.** Filter by address, sender, label, date and status. Filters stack as chips you can back out of one step at a time.
- **Full mail client.** Rich-text compose, reply, reply all, forward, drafts, attachments, folders, stars, search and message source view.
- **Labels and bulk actions.** Select many conversations to archive, delete, mark read, star, label or move. Undo is available after each action.
- **Keyboard shortcuts** for navigation and actions.
- **Per-address isolation.** Every address has its own Durable Object, database and prompt settings.
- **AI agent.** A side panel that can read, search and draft using Workers AI. Automatic drafting of new mail is off by default (`AUTO_DRAFT_ENABLED`).
- **MCP server** for connecting outside agents.
- **Cloudflare Access required.** Outside local development the Worker refuses every request until Access is configured.

## Stack

- **Frontend:** React 19, React Router v7 (server rendered), Tailwind CSS, TanStack Query, Zustand, TipTap, `@cloudflare/kumo`
- **Backend:** Hono, Cloudflare Workers, Durable Objects (SQLite), R2, Email Routing, Email Sending
- **Agent:** Cloudflare Agents SDK, AI SDK v6, Workers AI
- **Auth:** Cloudflare Access JWT validation

## Setup

Requirements: a domain on Cloudflare, R2, and Workers Paid for outbound email.

1. **Install.** `npm install`
2. **Configure `wrangler.jsonc`.** Set `name`, `account_id`, `vars.APP_NAME`, `vars.DOMAINS`, `vars.EMAIL_ADDRESSES` and the route `pattern`. Every address must belong to a domain in `DOMAINS`.
3. **Create the R2 bucket** named in `r2_buckets`: `npx wrangler r2 bucket create agents-go-postal`
4. **Deploy.** `npm run deploy`
5. **Turn on Cloudflare Access** for the Worker under Settings > Domains & Routes ([one-click Access](https://developers.cloudflare.com/changelog/post/2025-10-03-one-click-access-for-workers/)). Copy the values the modal shows into Worker secrets:
   ```sh
   npx wrangler secret put POLICY_AUD
   npx wrangler secret put TEAM_DOMAIN
   ```
   `TEAM_DOMAIN` may be the team URL or the full `/cdn-cgi/access/certs` URL.
6. **Route mail to the Worker.** In your domain's Email Routing, add a catch-all rule (or one rule per address) with the action **Send to Worker**.
7. **Enable Email Sending** for the domain so the `send_email` binding can deliver replies. See the [Email Service docs](https://developers.cloudflare.com/email-routing/email-workers/send-email-workers/).
8. **Check it.** `npm run smoke` expects every request to redirect to the Access login.

### Troubleshooting Access

- `Invalid or expired Access token`: `POLICY_AUD` or `TEAM_DOMAIN` is wrong. Turn Access off and on for the Worker to see the values again, then reset both secrets.
- `Cloudflare Access must be configured in production`: the secrets are missing. The Worker fails closed on purpose.

## Configuration

| Setting | Where | Purpose |
| --- | --- | --- |
| `APP_NAME` | `vars` | Name in the header, status bar and page titles |
| `DOMAINS` | `vars` | Comma-separated domains that receive mail |
| `EMAIL_ADDRESSES` | `vars` | Addresses that get a mailbox. Mail to other addresses is rejected. |
| `MAIL_UI` | `vars` | `unified` for one list, `classic` for the per-mailbox routes |
| `INDEX_SYNC_ENABLED` | `vars` | `false` pauses updates to the combined index; changes queue in each mailbox |
| `AUTO_DRAFT_ENABLED` | `vars` | `true` drafts a reply to each new message |
| `POLICY_AUD`, `TEAM_DOMAIN` | secrets | Cloudflare Access verification |

To rebrand a deployment, set `APP_NAME` and replace the files listed in `public/brand/README.md`.

## Local development

```sh
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

Access checks are skipped in development.

## Checks

```sh
npm test
npm run typecheck
npm run build
```

Design rules live in `DESIGN.md`. `tests/design-rules.test.mjs` enforces the ones that can be checked.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
