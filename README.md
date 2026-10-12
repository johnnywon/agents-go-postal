# Agents Go Postal

**One inbox for every address. Built for AI.**

Email is older than the web, and for most of that time it has lived in someone else's house. You rented an inbox from Google or Microsoft and took what they gave you.

Cloudflare Email Routing hands that mail to your own code instead. Every message to your domain arrives in a Worker you deploy, and Email Service sends replies from the same Worker with SPF, DKIM and DMARC already in place.

What Cloudflare doesn't give you is somewhere to read it. Agents Go Postal is that inbox: every address on every domain in one list, on desktop or phone, with an agent that can search, label, draft and send. It runs entirely on your Cloudflare account.

> **Work in progress.** It handles real mail every day and changes every week. Pin a commit if you deploy it, and see the [roadmap](#roadmap).

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/johnnywon/agents-go-postal)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![Runs on Cloudflare Workers](https://img.shields.io/badge/runs%20on-Cloudflare%20Workers-f38020?logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/workers/)

![The inbox: every address in one list, a conversation open, the agent on the right](docs/images/inbox.jpg)

## What you can run on it

- **A startup with several arms.** The company domain, the product domain and the docs domain each have `sales@`, `support@`, `billing@` and `press@`. All of it lands in one list. The agent drafts support replies and files invoices, and every reply leaves from the address that received the mail.
- **A consultant or agency with mail per client.** Each engagement gets an address on its own domain. One inbox, a label per client, and `to:` narrows the list to one client.
- **An indie developer with a shelf of side projects.** `hello@`, `abuse@` and app store contact addresses for ten small products, without ten mailbox plans or a tangle of forwards into one personal account.
- **Agents that need their own address.** Give a support agent `support@` and a finance agent `receipts@`. They read, label and draft through MCP. You see every message and every draft in the same list.
- **Finance and ops across several companies.** Invoices, receipts and alerts from every entity in one place. With attachment search on, `INV-2207` finds the invoice even when the number only appears inside the PDF.

## Product tour

### 1. Search every address at once

![Search with operators, top results and filters that narrow them](docs/images/search.jpg)

Operators, phrases, exclusions and `OR`, with results ranked by relevance and filters that narrow them as you type. A plain request like "unread newsletters this week" becomes a search you can see and edit.

**For developers:** one parser ([`shared/search-query.ts`](shared/search-query.ts)) compiles to one full-text query. The same string works in the URL (`?search=`), in the agent's `search_all_mail` and in every MCP search tool. Test a query in the UI, then hand it to an agent unchanged.

### 2. Reply from the right address

![Replying from the address the message reached, with the original quoted](docs/images/compose.jpg)

Replies go out from the address the message reached, with the original quoted. Drafts the agent writes open in the same composer, so you review and send.

**For developers:** sends go through Cloudflare's `send_email` binding. Each send carries an idempotency key, and a saved draft always sends with `draft:<id>`, so a draft goes out once whether a person, the agent or the scheduler sends it. Retries are safe by construction.

### 3. Plug in any agent over MCP

<p align="center"><img src="docs/images/mcp.jpg" alt="The MCP panel: the server URL and 19 tools" width="560"></p>

The MCP panel gives you the server URL and lists every tool: read, search, draft, send, label and move, across every address.

**For developers:** 19 tools over the same store the UI uses, behind the same Cloudflare Access login. Point Claude Code, Cursor or your own agent at `/mcp`. `search_all_mail` and `label_matching` act on every address in one call, so a triage workflow needs a prompt and nothing else to host.

### Also in the box

An agent panel inside the app that searches, labels, drafts and sends when you ask, on Workers AI or any OpenRouter model with your key. Drafts, attachments, stars, archive, bulk actions with undo, scheduled send, signatures, keyboard shortcuts and a phone layout. The Worker refuses every request until Cloudflare Access is set up, and incoming HTML is sanitised, sandboxed and shown without remote images until you ask.

## How it works

```mermaid
flowchart LR
    sender([Sender]) --> routing[Email Routing]
    routing -->|email handler| worker[Worker<br/>Hono API + React Router]
    you([You, in a browser]) -->|Cloudflare Access| worker
    mcp([Claude Code, Cursor,<br/>other MCP clients]) -->|/mcp| worker
    worker --> store[(Mail store<br/>D1, or one Durable Object<br/>per address + an index)]
    worker --> r2[(R2<br/>attachments, large bodies)]
    worker <--> agent[Agent<br/>Durable Object]
    agent --> ai[Workers AI<br/>or OpenRouter]
    worker -->|send_email| sending[Email Service] --> recipient([Recipient])
    cron([Cron, every minute]) -.->|scheduled sends,<br/>attachment text| worker
```

Everything runs in one Worker on your account. Mail is stored either in D1 (one database for every address) or in a Durable Object per address with a combined index. D1 is where the project is heading; see the roadmap.

What happens when a message arrives:

```mermaid
sequenceDiagram
    participant S as Sender
    participant R as Email Routing
    participant W as Worker
    participant B as R2
    participant M as Mail store
    participant A as Agent
    S->>R: Message to hello@example.com
    R->>W: email() event
    W->>W: Parse, check the address is configured
    W->>B: Save attachments
    W->>M: Save the message, thread it
    opt AUTO_DRAFT_ENABLED
        W->>A: Draft a reply (skips lists and no-reply senders)
    end
    Note over M: It appears in the one list, under its address
```

## Quick start

Requirements: a domain on Cloudflare, the Workers Paid plan (for sending) and R2.

1. Click **Deploy to Cloudflare** above. It copies the repo to your GitHub, creates the storage and deploys.
2. Set your addresses in `wrangler.jsonc` (`DOMAINS`, `EMAIL_ADDRESSES`) and push.
3. Turn on Cloudflare Access for the Worker and save its two values as secrets.
4. Route each address to the Worker with Email Routing, and enable Email Sending.

Each step, with commands, is in [docs/setup.md](docs/setup.md). To run it locally with sample mail, see [docs/development.md](docs/development.md).

<p align="center"><img src="docs/images/mobile.jpg" alt="The list and a receipt on a phone" width="620"></p>

## Roadmap

Shipped: one list for every address, labels and bulk actions with undo, scheduled send, the in-app agent, the MCP server, one search language, D1 storage with ranked and attachment search, Move to Inbox and Empty Trash.

These are the directions under consideration. [Open an issue](https://github.com/johnnywon/agents-go-postal/issues) to argue for one or propose another.

### Now: make it easy to run

- [ ] **One-command setup.** A CLI that creates the Email Routing rule for each address, enables Email Sending, turns on Access and writes the secrets. Setting up a new address becomes one command.
- [ ] **D1 as the only store.** Finish the migration and remove the Durable Object mail path, so there is one storage model to learn and test.
- [ ] **CI on every pull request.** Run tests, typecheck and build in GitHub Actions, plus a browser smoke test against a seeded dev server.
- [ ] **Import existing mail.** Bring in an mbox or IMAP export so a new deployment starts with history.

### Next: agents you can trust with an inbox

- [ ] **Approval queue.** Agent sends and bulk changes can wait for one-click approval, with a log of every action an agent took and why.
- [ ] **Scoped access for agents.** MCP tokens limited to chosen addresses, read-only or draft-only, so a support agent never sees billing mail.
- [ ] **Rules in plain words.** "File receipts under Receipts" or "draft replies for support@" runs on each new message, shown as a readable rule you can edit.
- [ ] **Events for other Workers.** Publish new-mail and label events to Cloudflare Queues, so your own code can react without polling.

### Later: teams and depth

- [ ] **Per-person access.** People see only the addresses they are given, with assignment and internal notes for shared inboxes.
- [ ] **Search by meaning.** Opt-in Vectorize search alongside full-text, for "the email where they offered a discount".
- [ ] **Notifications and offline.** Web push for new mail and an installable app that reads cached mail offline.
- [ ] **Delete one message forever** from Trash, alongside Empty Trash.

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
