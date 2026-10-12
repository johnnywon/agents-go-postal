<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/brand/logo-stacked-dark.svg">
    <img src="public/brand/logo-stacked.svg" alt="Agents Go Postal" width="320">
  </picture>
</h1>

**An inbox your agents can work. Self-hosted email UI and MCP server for every address on your domains, on Cloudflare Workers.**

Every message to your domain arrives in a Worker you deploy, and Email Service sends replies from the same Worker, with SPF and DKIM set up when you enable Email Sending.

Cloudflare doesn't include a mail client. Agents Go Postal is one: every address on every domain in one list, on desktop or phone, with an agent that can search, label, draft and send. It runs entirely on your Cloudflare account.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/johnnywon/agents-go-postal)
[![Version 0.3.0](https://img.shields.io/badge/version-0.3.0-blue)](https://github.com/johnnywon/agents-go-postal/releases)
[![CI](https://github.com/johnnywon/agents-go-postal/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/johnnywon/agents-go-postal/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![Runs on Cloudflare Workers](https://img.shields.io/badge/runs%20on-Cloudflare%20Workers-f38020?logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/workers/)

Needs a domain on Cloudflare, R2 and Cloudflare Access. Sending needs the Workers Paid plan and Cloudflare Email Sending, which is in public beta. See the [quick start](#quick-start).

**v0.3.0, ready to deploy.** One production deployment has handled real mail on it every day since May 2026. Before 1.0, an upgrade can need a step, such as a D1 migration or a config change, and the [changelog](CHANGELOG.md) names it in every release. Pin a [release](https://github.com/johnnywon/agents-go-postal/releases) tag to choose when you upgrade. See [Before you deploy](#before-you-deploy).

![The inbox: every address in one list, a conversation open, the agent on the right](docs/images/inbox.jpg)

## What you can run on it

- **A startup with several arms.** The company domain, the product domain and the docs domain each have `sales@`, `support@`, `billing@` and `press@`. All of it lands in one list. The agent drafts support replies and files invoices, and every reply leaves from the address that received the mail.
- **A consultant or agency with mail per client.** Each engagement gets an address on its own domain. One inbox, a label per client, and `to:` narrows the list to one client.
- **An indie developer with a shelf of side projects.** `hello@`, `abuse@` and app store contact addresses for ten small products, without ten mailbox plans or forwarding everything to a personal account.
- **Agents working your mail.** Connect a support agent or a finance agent over MCP. They search, label, draft and send across your addresses, and every message and draft shows up in the same list. Limiting an agent to chosen addresses is on the [roadmap](#roadmap).
- **Finance and ops across several companies.** Invoices, receipts and alerts from every entity in one place. On D1 with attachment search on, `INV-2207` finds the invoice even when the number only appears inside the PDF.

## Product tour

### 1. Search every address at once

![Search with operators, top results and filters that narrow them](docs/images/search.jpg)

Operators, phrases, exclusions and `OR`, with results ranked by relevance and filters that narrow them as you type. A plain request like "unread newsletters this week" becomes a search you can see and edit.

**For developers:** one parser ([`shared/search-query.ts`](shared/search-query.ts)) compiles to one full-text query. The same string works in the URL (`?search=`), in the agent's `search_all_mail` and in every MCP search tool. Test a query in the UI, then hand it to an agent unchanged.

### 2. Reply from the right address

![Replying from the address the message reached, with the original quoted](docs/images/compose.jpg)

Replies go out from the address the message reached, with the original quoted. Drafts the agent writes open in the same composer, so you review and send.

**For developers:** sends go through Cloudflare's `send_email` binding. Each send carries an idempotency key, and a saved draft always sends with `draft:<id>`, so a draft goes out once whether a person, the agent or the scheduler sends it.

### 3. Plug in any agent over MCP

<p align="center"><img src="docs/images/mcp.jpg" alt="The MCP panel: the server URL and its tools" width="560"></p>

The MCP panel gives you the server URL and lists every tool: read, search, draft, send, label and move, across every address.

**For developers:** 22 tools over the same store the UI uses, behind the same Cloudflare Access login. Point Claude Code, Cursor or your own agent at `/mcp`. `search_all_mail` and `label_matching` act on every address in one call. `set_shortcut` rebinds the app's keyboard shortcuts.

### Also in the box

An agent panel inside the app that searches, labels, drafts and sends when you ask, on Workers AI, or on OpenRouter's zero data retention endpoints with your key. Free models and providers that keep or train on prompts can't be connected. Drafts, attachments, stars, archive, bulk actions with undo, scheduled send, signatures and a phone layout. Keyboard shortcuts follow Gmail, `?` shows where each one acts, and you or an agent can rebind any of them. The Worker refuses every request until Cloudflare Access is set up, and incoming HTML is sanitised, sandboxed and shown without remote images until you ask.

## Why not something else

- **Forwarding to Gmail or Outlook.** Each address needs its own Send As setup, and an agent you connect sees your whole personal mailbox.
- **A mailbox plan per address.** Cost grows with every address and domain, and agents reach the mail through IMAP or a vendor API.
- **A mail server on a VPS.** A server to patch, an IP reputation to keep, and a mail client still to choose. Here Cloudflare handles delivery, SPF and DKIM, and the client and agent tools come with it.

## How it works

```text
   Sender           You, in a browser    Claude Code, Cursor,   Cron, every
     |                    |              other MCP clients      minute
     v                    v                    |                  | on D1:
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
| D1, or one  |  | attachments,|  | Durable Object |  | send_email    |
| DO per      |  | large bodies|  +----------------+  +---------------+
| address     |  | on D1       |          |                    |
| + an index  |  +-------------+          v                    v
+-------------+                   Workers AI or            Recipient
                                  OpenRouter (zero
                                  data retention)
```

Everything runs in one Worker on your account. Mail is stored either in a Durable Object per address with a combined index, which is what a fresh deploy uses, or in D1, one database for every address. D1 adds attachment search, the `filename:`, `cc:`, `has:pdf`, `has:image`, `has:link` and `is:scheduled` operators, and large bodies in R2, and its cron sends scheduled mail. On Durable Objects, each mailbox's own alarm sends its scheduled mail. D1 is where the project is heading; see [Moving to D1](docs/setup.md#moving-to-d1) and the roadmap.

What happens when a message arrives:

```text
Sender
  |  message to hello@example.com
  v
Email Routing
  |  email() event
  v
Worker
  1. Parse it. Mail to an address that isn't configured is dropped.
  2. Attachments ---------------------------------> R2
  3. The message, threaded into its conversation --> Mail store
  4. With AUTO_DRAFT_ENABLED, ask for a reply -----> Agent
     (skips mailing lists and no-reply senders)
  |
  v
It appears in the one list, under its address.
```

What happens when you send:

```text
You, the in-app agent, or an MCP client
  |  send as billing@example.com
  v
Worker
  1. Claim the send key, so a retried request can't send twice.
  2. Check the From address is the mailbox's own address.
  3. Thread it onto the conversation it replies to.
  4. send_email ---------> Email Service ---------> Recipient
                           (SPF and DKIM
                            on your domain)
  5. Attachments --------> R2
  6. The Sent copy ------> Mail store
```

A scheduled send waits in the store until its time. On D1 the cron sends it; on Durable Objects the mailbox's alarm does. Either way it runs these same steps.

## Before you deploy

**What you can rely on**

- Your mail stays in your Cloudflare account: Durable Objects or D1, with attachments in R2. No outside service sees it unless you choose an OpenRouter model, and those are limited to zero data retention endpoints.
- The Worker refuses every request until Cloudflare Access is set up.
- A send goes out once. A retried request, a double click or the scheduler can't send it twice.
- Storage classes and migrations are append-only, so an upgrade doesn't drop stored mail.
- Tests, a typecheck and a build must pass before anything merges to main.

**What to know first**

- Sending runs on Cloudflare Email Sending, in public beta since April 2026 and only on Workers Paid. New accounts start with a low daily sending quota that grows with your sending record. A message can have up to 50 recipients and be up to 5 MiB with attachments. Receiving runs on Email Routing, which isn't in beta and works on Workers Free.
- Agents can send. The in-app agent and MCP clients send a draft when you ask them to, with no approval step yet; that's next on the [roadmap](#roadmap). Automatic drafting only drafts.
- There's no mail export or import yet. On D1, `wrangler d1 time-travel` restores the database to any minute in the last 30 days.
- It's a web app and an MCP server. There's no IMAP or SMTP, so Apple Mail or Thunderbird can't connect.
- Everyone who passes Access sees every address. Per-person access is on the roadmap.
- The agent's model usage is billed per token by Workers AI or OpenRouter. Settings shows each model's price.

## Quick start

Requirements: a domain on Cloudflare, R2, and the Workers Paid plan to send mail. On Workers Free, Email Service only sends to addresses verified in your own account.

1. Click **Deploy to Cloudflare** above. It copies the repo to your GitHub, creates the storage and deploys.
2. The deploy form has no field for your addresses, so set `DOMAINS` and `EMAIL_ADDRESSES` in `wrangler.jsonc` in the new repo and push.
3. Turn on Cloudflare Access for the Worker and save its two values as secrets. Until then, every request returns an error asking for Access.
4. Route each address to the Worker with Email Routing, and enable Email Sending.

This starts on Durable Object storage. For attachment search and every search operator, [move to D1](docs/setup.md#moving-to-d1). Each step, with commands, is in [docs/setup.md](docs/setup.md). To run it locally with sample mail, see [docs/development.md](docs/development.md).

<p align="center"><img src="docs/images/mobile.jpg" alt="The list and a receipt on a phone" width="620"></p>

## Roadmap

Where it stands and what to know before deploying is in [Before you deploy](#before-you-deploy).

Shipped: one list for every address, one search language with ranked results, the in-app agent and the MCP server, a choice of agent model limited to providers that don't keep or train on your mail, labels and bulk actions with undo, scheduled send, D1 storage with attachment search, and keyboard shortcuts that people and agents can rebind.

[Open an issue](https://github.com/johnnywon/agents-go-postal/issues) to argue for one of these or propose another.

### Now: a faster start

- [ ] **One-command setup.** A CLI that creates the Email Routing rule for each address, enables Email Sending, turns on Access and writes the secrets. Adding an address becomes one command.
- [ ] **Import existing mail.** Bring in an mbox or IMAP export so a new deployment starts with your history.
- [ ] **Start on Workers Free.** Receive, read, search and use the agent without a paid plan, and add Workers Paid when you want to send.

### Next: control over what agents do

- [ ] **Scoped agent access.** MCP tokens limited to chosen addresses, read-only or draft-only, so a support agent never sees billing mail.
- [ ] **Approval queue and activity log.** Agent sends and bulk changes can wait for one-click approval, and every action an agent took is logged with its reason.
- [ ] **Rules in plain words.** "File receipts under Receipts" or "draft replies for support@" runs on each new message, shown as a rule you can read and edit.

### Later: teams and reach

- [ ] **Shared inboxes.** People see only the addresses they are given, with assignment and internal notes.
- [ ] **Events for other Workers.** New-mail and label events on Cloudflare Queues, so your own code can react without polling.
- [ ] **Search by meaning.** Opt-in Vectorize search alongside full-text, for "the email where they offered a discount".
- [ ] **Notifications and offline.** Web push for new mail and an installable app that reads cached mail offline.

Underneath: D1 becomes the only store, so there is one storage model to learn and upgrade, and CI gains a browser check against a seeded dev server.

## Docs

| | |
|---|---|
| [Setup](docs/setup.md) | Deploy, Access, Email Routing and Sending, configuration, moving to D1 |
| [Guide](docs/guide.md) | Every feature, keyboard shortcuts, the search language, the agent model |
| [Development](docs/development.md) | Local dev with sample mail, tests and checks |
| [Design](DESIGN.md) | The design system the UI follows |

## Contributing

Issues and pull requests are welcome. Before you open a PR:

```sh
npm test
npm run typecheck
npm run build
```

Keep changes small and focused. UI changes follow [DESIGN.md](DESIGN.md), and `tests/design-rules.test.mjs` checks the rules it can. Use `example.com`, `example.org` and `example.net` in config, docs and tests.

## Credits and license

Derived from [cloudflare/agentic-inbox](https://github.com/cloudflare/agentic-inbox) by Cloudflare. Apache-2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE).
