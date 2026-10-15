<h1>
<picture>
  <source media="(prefers-color-scheme: light)" srcset="docs/images/logo-light.png">
  <img src="docs/images/logo.png" alt="PluraMail" width="320">
</picture>
</h1>

Self-hosted webmail and MCP server for Cloudflare Email Routing. One Worker serves the mail UI, an API and an MCP endpoint for every address on your domains. Mail is stored in D1 and R2 in your own Cloudflare account.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/johnnywon/pluramail)
[![Version 0.8.2](https://img.shields.io/badge/version-0.8.2-blue)](https://github.com/johnnywon/pluramail/releases)
[![CI](https://github.com/johnnywon/pluramail/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/johnnywon/pluramail/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![Runs on Cloudflare Workers](https://img.shields.io/badge/runs%20on-Cloudflare%20Workers-f38020?logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/workers/)

Demo: [pluramail-demo.pluramail.workers.dev](https://pluramail-demo.pluramail.workers.dev). Sample data, no sign-in, sending disabled, reset every hour.

<picture>
  <source media="(prefers-color-scheme: light)" srcset="docs/images/inbox-light.jpg">
  <img src="docs/images/inbox.jpg" alt="The inbox: every address in one list, a conversation open, the agent on the right">
</picture>

## Requirements

- A domain on Cloudflare with Email Routing
- D1, R2 and Cloudflare Access
- For sending: Workers Paid and Cloudflare Email Sending (public beta)

## Status

Pre-1.0. A minor release can require a D1 migration or a configuration change. [CHANGELOG.md](CHANGELOG.md) lists the required steps for each release, and `npm run deploy` applies D1 migrations before it deploys. Pin a [release](https://github.com/johnnywon/pluramail/releases) tag to control when you upgrade.

## Features

- One list for every address across your domains, with views per address and per domain, labels and saved searches.
- Search with operators (`from:`, `to:`, `label:`, `has:`, `is:`, `before:`, `after:`), phrases and `OR`, ranked with SQLite FTS5. The same syntax works in URLs, the in-app agent and the MCP tools.
- Replies are sent from the address that received the message.
- An in-app agent on Workers AI, or on OpenRouter models with zero data retention, that can search, label, draft and send within per-address daily limits.
- An MCP server at `/mcp` with 22 tools, behind the same Cloudflare Access policy as the app.
- Attachments, bulk actions with undo, scheduled send, signatures, rebindable keyboard shortcuts and a phone layout.

<picture>
  <source media="(prefers-color-scheme: light)" srcset="docs/images/search-light.jpg">
  <img src="docs/images/search.jpg" alt="Search with operators, top results and filters that narrow them">
</picture>

<picture>
  <source media="(prefers-color-scheme: light)" srcset="docs/images/compose-light.jpg">
  <img src="docs/images/compose.jpg" alt="Replying from the address the message reached, with the original quoted">
</picture>

<p align="center">
<picture>
  <source media="(prefers-color-scheme: light)" srcset="docs/images/mcp-light.jpg">
  <img src="docs/images/mcp.jpg" alt="The Console's Connections tab: the MCP server URL and its tools" width="700">
</picture>
</p>

<p align="center">
<picture>
  <source media="(prefers-color-scheme: light)" srcset="docs/images/mobile-light.jpg">
  <img src="docs/images/mobile.jpg" alt="The list and an invoice on a phone" width="620">
</picture>
</p>

## Architecture

```text
   Sender           You, in a browser    Claude Code, Cursor,   Cron, every
     |                    |              other MCP clients      minute
     v                    v                    |                  |
+---------------+  +-----------------+         | /mcp             | scheduled
| Email Routing |  | Cloudflare      |         |                  | sends,
+---------------+  | Access          |         |                  | attachment
     | email()     +-----------------+         |                  | text
     v                    v                    v                  v
+----------------------------------------------------------------------+
|                Worker: Hono API + React Router UI                    |
+----------------------------------------------------------------------+
     |                 |                  |                    |
     v                 v                  v                    v
+-------------+  +-------------+  +----------------+  +---------------+
| Mail store  |  | R2          |  | Agent          |  | Email Service |
| D1, one     |  | attachments,|  | Durable Object |  | send_email    |
| database    |  | large bodies|  +----------------+  +---------------+
| for every   |  |             |          |                    |
| address     |  +-------------+          v                    v
+-------------+                   Workers AI or            Recipient
                                  OpenRouter (zero
                                  data retention)
```

A single Worker handles inbound mail (`email()`), the HTTP API and UI, the MCP endpoint and a cron trigger for scheduled sends and attachment text. Mail metadata and search indexes are in one D1 database for all addresses; attachments and large bodies are in R2. The agent runs in a Durable Object. Details are in [docs/architecture.md](docs/architecture.md).

## Security and data

- Mail stays in your Cloudflare account. It leaves only if you select an OpenRouter model, and the model list is limited to zero data retention endpoints.
- Requests are refused until Cloudflare Access is configured.
- Incoming HTML is sanitized and rendered in a sandboxed iframe.
- Each send uses a send key, so a retried request does not send twice.
- D1 migrations are append-only.

## Limitations

- Email Sending is in public beta. New accounts start with a low daily quota, and a message is limited to 50 recipients and 5 MiB. Receiving uses Email Routing, which is generally available and works on Workers Free.
- Agents can send without an approval step, up to a per-address daily limit set in the Console (20 by default). Agent actions are logged in Console > Activity. An approval queue is on the [roadmap](#roadmap).
- There is no export, IMAP or SMTP. `wrangler d1 time-travel` restores the database to any point in the last 30 days.
- There are no per-user permissions. Everyone who passes Access can read every address.

## Quick start

1. Click **Deploy to Cloudflare** above and enter your domain and addresses. It copies the repository to your GitHub account, creates the storage and deploys.
2. Turn on Cloudflare Access for the Worker and save its two values as secrets.
3. Route each address to the Worker with Email Routing, and enable Email Sending.

Each step, with commands, is in [docs/setup.md](docs/setup.md).

## Roadmap

- **Now:** an approval queue and scoped agent access.
- **Next:** one-command setup, mail import, running on Workers Free, rules in plain words.
- **Later:** shared inboxes, Queue events, semantic search, notifications and offline use.

Details are in [docs/roadmap.md](docs/roadmap.md). Use [issues](https://github.com/johnnywon/pluramail/issues) for requests and bug reports.

## Docs

| | |
|---|---|
| [Setup](docs/setup.md) | Deploy, Access, Email Routing and Sending, configuration, moving to D1 |
| [Guide](docs/guide.md) | Every feature, keyboard shortcuts, the search language, the agent model |
| [Architecture](docs/architecture.md) | How mail arrives and leaves, storage, notes for developers |
| [Development](docs/development.md) | Local dev with sample mail, tests and checks |
| [Design](DESIGN.md) | The design system the UI follows |

## Contributing

Run `npm test`, `npm run typecheck` and `npm run build` before opening a pull request, and use `example.com`, `example.org` and `example.net` in config, docs and tests. See [docs/development.md](docs/development.md).

## Credits and license

Derived from [cloudflare/agentic-inbox](https://github.com/cloudflare/agentic-inbox) by Cloudflare. Apache-2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE).
