# Architecture

How the Worker is put together, what happens when mail arrives and when you send, and where each piece of the code lives.

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

Everything runs in one Worker on your account. Mail is stored in D1, one database for every address, which is what a fresh deploy uses. Deployments from before 0.5 can still store it in a Durable Object per address with a combined index until they move ([Moving to D1](setup.md#moving-to-d1)); that store is removed in 0.6. D1 adds attachment search, the `filename:`, `cc:`, `has:pdf`, `has:image`, `has:link` and `is:scheduled` operators, and large bodies in R2, and its cron sends scheduled mail. On Durable Objects, each mailbox's own alarm sends its scheduled mail.

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

## For developers

- **Search.** One parser ([`shared/search-query.ts`](../shared/search-query.ts)) compiles to one full-text query. The same string works in the URL (`?search=`), in the agent's `search_all_mail` and in every MCP search tool. Test a query in the UI, then hand it to an agent unchanged.
- **Sending.** Sends go through Cloudflare's `send_email` binding. Each send carries an idempotency key, and a saved draft always sends with `draft:<id>`, so a draft goes out once whether a person, the agent or the scheduler sends it.
- **MCP.** 22 tools over the same store the UI uses, behind the same Cloudflare Access login. Point Claude Code, Cursor or your own agent at `/mcp`. `search_all_mail` and `label_matching` act on every address in one call. `set_shortcut` rebinds the app's keyboard shortcuts.
