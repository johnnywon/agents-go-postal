# Roadmap

Where the project stands and what to know before deploying is in the [README](../README.md#before-you-deploy).

Shipped: one list for every address, one search language with ranked results, the in-app agent and the MCP server, a choice of agent model limited to providers that don't keep or train on your mail, labels and bulk actions with undo, scheduled send, D1 storage with attachment search, and keyboard shortcuts that people and agents can rebind.

[Open an issue](https://github.com/johnnywon/open-mailroom/issues) to argue for one of these or propose another.

## Now: control over what agents do

- [x] **Activity log.** Every read, draft, send, delete and label change by the agent, auto-draft and MCP clients, in Settings > Activity.
- [ ] **Approval queue.** Agent sends and bulk changes can wait for one-click approval.
- [ ] **Scoped agent access.** MCP tokens limited to chosen addresses, read-only or draft-only, so a support agent never sees billing mail.

## Next: a faster start, and rules

- [ ] **One-command setup.** A CLI that creates the Email Routing rule for each address, enables Email Sending, turns on Access and writes the secrets. Adding an address becomes one command.
- [ ] **Import existing mail.** Bring in an mbox or IMAP export so a new deployment starts with your history.
- [ ] **Start on Workers Free.** Receive, read, search and use the agent without a paid plan, and add Workers Paid when you want to send.
- [ ] **Rules in plain words.** "File receipts under Receipts" or "draft replies for support@" runs on each new message, shown as a rule you can read and edit.

## Later: teams and reach

- [ ] **Shared inboxes.** People see only the addresses they are given, with assignment and internal notes.
- [ ] **Events for other Workers.** New-mail and label events on Cloudflare Queues, so your own code can react without polling.
- [ ] **Search by meaning.** Opt-in Vectorize search alongside full-text, for "the email where they offered a discount".
- [ ] **Notifications and offline.** Web push for new mail and an installable app that reads cached mail offline.

Underneath: D1 becomes the only store, so there is one storage model to learn and upgrade, and CI gains a browser check against a seeded dev server.
