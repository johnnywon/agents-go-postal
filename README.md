# Open Mailroom

**An inbox your agents can work. Self-hosted email UI and MCP server for every address on your domains, on Cloudflare Workers.**

Cloudflare receives and sends your domain's mail but doesn't include a mail client. Open Mailroom is one: every address on every domain in one list, on desktop or phone, with an agent that can search, label, draft and send. It runs entirely in your Cloudflare account.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/johnnywon/open-mailroom)
[![Version 0.7.5](https://img.shields.io/badge/version-0.7.5-blue)](https://github.com/johnnywon/open-mailroom/releases)
[![CI](https://github.com/johnnywon/open-mailroom/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/johnnywon/open-mailroom/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![Runs on Cloudflare Workers](https://img.shields.io/badge/runs%20on-Cloudflare%20Workers-f38020?logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/workers/)

Needs a domain on Cloudflare, R2 and Cloudflare Access. Sending needs the Workers Paid plan and Cloudflare Email Sending, which is in public beta.

**v0.7.5, ready to deploy.** One production deployment has handled real mail on it every day since May 2026. Before 1.0, an upgrade can need a step, such as a D1 migration or a config change, and the [changelog](CHANGELOG.md) names it in every release. Pin a [release](https://github.com/johnnywon/open-mailroom/releases) tag to choose when you upgrade.

<picture>
  <source media="(prefers-color-scheme: light)" srcset="docs/images/inbox-light.jpg">
  <img src="docs/images/inbox.jpg" alt="The inbox: every address in one list, a conversation open, the agent on the right">
</picture>

## What you can run on it

- **Several companies or products.** `sales@`, `support@` and `billing@` on every domain land in one list, and each reply leaves from the address that received the mail.
- **A domain per client.** One inbox, a label per client, and `to:` narrows the list to one of them.
- **Agents working your mail.** Connect Claude Code, Cursor or your own agent over MCP to search, label, draft and send across every address.

## Product tour

<picture>
  <source media="(prefers-color-scheme: light)" srcset="docs/images/search-light.jpg">
  <img src="docs/images/search.jpg" alt="Search with operators, top results and filters that narrow them">
</picture>

**Search every address at once.** Operators, phrases and `OR`, ranked by relevance. The same query works in the URL, the agent and every MCP tool.

<picture>
  <source media="(prefers-color-scheme: light)" srcset="docs/images/compose-light.jpg">
  <img src="docs/images/compose.jpg" alt="Replying from the address the message reached, with the original quoted">
</picture>

**Reply from the right address.** Replies go out from the address the message reached. Drafts the agent writes open in the same composer for you to review and send.

<p align="center">
<picture>
  <source media="(prefers-color-scheme: light)" srcset="docs/images/mcp-light.jpg">
  <img src="docs/images/mcp.jpg" alt="The MCP panel: the server URL and its tools" width="560">
</picture>
</p>

**Plug in any agent over MCP.** 22 tools to read, search, draft, send, label and move, behind the same Cloudflare Access login as the app.

Also: an in-app agent on Workers AI or zero data retention OpenRouter models, attachments, bulk actions with undo, scheduled send, signatures, Gmail-style keyboard shortcuts and a phone layout.

<p align="center">
<picture>
  <source media="(prefers-color-scheme: light)" srcset="docs/images/mobile-light.jpg">
  <img src="docs/images/mobile.jpg" alt="The list and a receipt on a phone" width="620">
</picture>
</p>

## Why not something else

- **Forwarding to Gmail or Outlook.** Each address needs its own Send As setup, and an agent you connect sees your whole personal mailbox.
- **A mailbox plan per address.** Cost grows with every address and domain, and agents reach the mail through IMAP or a vendor API.
- **A mail server on a VPS.** A server to patch, an IP reputation to keep, and a mail client still to choose. Here Cloudflare handles delivery, SPF and DKIM, and the client and agent tools come with it.

## How it works

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

One Worker in your account. Mail is stored in D1, one database for every address. How mail arrives and leaves is in [Architecture](docs/architecture.md).

## Before you deploy

**What you can rely on**

- Your mail stays in your Cloudflare account. No outside service sees it unless you choose an OpenRouter model, and those are limited to zero data retention endpoints.
- Every request is refused until Cloudflare Access is set up, and incoming HTML is sanitised and sandboxed.
- A send goes out once, even when a request is retried.
- Upgrades don't drop stored mail. Storage migrations are append-only.

**What to know first**

- Email Sending is in public beta and needs Workers Paid. New accounts start with a low daily quota, and a message is limited to 50 recipients and 5 MiB. Receiving uses Email Routing, which isn't in beta and works on Workers Free.
- Agents can send when you ask them to, up to a daily limit per address you set in the Console (20 by default). There's no approval step yet; it's the first item on the [roadmap](#roadmap). Console > Activity shows what they did.
- There's no mail export, IMAP or SMTP yet. `wrangler d1 time-travel` restores the last 30 days.
- Everyone who passes Access sees every address.

## Quick start

1. Click **Deploy to Cloudflare** above and enter your domain and addresses. It copies the repo to your GitHub, creates the storage and deploys.
2. Turn on Cloudflare Access for the Worker and save its two values as secrets.
3. Route each address to the Worker with Email Routing, and enable Email Sending.

Each step, with commands, is in [docs/setup.md](docs/setup.md).

## Roadmap

- **Now:** an approval queue, and scoped agent access.
- **Next:** one-command setup, mail import, starting on Workers Free, rules in plain words.
- **Later:** shared inboxes, Queue events, search by meaning, notifications and offline.

Details are in [docs/roadmap.md](docs/roadmap.md). [Open an issue](https://github.com/johnnywon/open-mailroom/issues) to argue for one or propose another.

## Docs

| | |
|---|---|
| [Setup](docs/setup.md) | Deploy, Access, Email Routing and Sending, configuration, moving to D1 |
| [Guide](docs/guide.md) | Every feature, keyboard shortcuts, the search language, the agent model |
| [Architecture](docs/architecture.md) | How mail arrives and leaves, storage, notes for developers |
| [Development](docs/development.md) | Local dev with sample mail, tests and checks |
| [Design](DESIGN.md) | The design system the UI follows |

## Contributing

Issues and pull requests are welcome. Run `npm test`, `npm run typecheck` and `npm run build` before you open one, and use `example.com`, `example.org` and `example.net` in config, docs and tests. See [docs/development.md](docs/development.md).

## Credits and license

Derived from [cloudflare/agentic-inbox](https://github.com/cloudflare/agentic-inbox) by Cloudflare. Apache-2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE).
