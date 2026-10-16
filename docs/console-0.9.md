# Console 0.9

Built in 0.9.0, apart from Test on past mail and Send, which arrive in 0.10. WON-231 and WON-209.

## In one line

Each agent does one job on the addresses you choose. It starts in Watch, moves to Draft, then to Send once you trust it.

## Pages

The console replaces the mail with its own rail, opened at `?console=<page>`.

| Page | What's on it |
|---|---|
| Overview | The last 24 hours: agent actions, sends, auto-drafts, failures, each agent's count today, sends per address |
| Your agents | Every agent: name, job, addresses, mode, in the order they take mail. The PluraMail Agent is the built-in one. |
| Draft review | Drafts waiting for you, as mail rows |
| Activity log | Every action by an agent, an MCP client or you, kept 90, 120 or 180 days |
| AI models | The agent model and its facts, and Cloudflare and OpenRouter side by side: training, retention, models, key |
| MCP | The server URL, connect steps per client, connected apps (OAuth grants, read or read and send) with Revoke |
| Addresses, Signatures, Labels, Preferences, Keyboard shortcuts, Mail storage | The 0.8 settings tabs |

## An agent

- **Job**: one sentence, in your words.
- **Addresses**: one, several, or all.
- **Mode**: Watch (shows what it would do), Draft (writes drafts for you), Send (replies on its own, up to a daily limit). Send is off in 0.9 and arrives in 0.10.
- **Instructions** and an **example reply**.
- One column: Trust, Activity, How it works. Test (run on past mail; nothing is sent) joins in 0.10.

New agents start in Watch.

## Rules

- An agent replies only to the sender of the message it took.
- Every reply passes the safety check first.
- Each agent has a daily limit (25 by default) and a limit of two replies a day to one sender.
- When two agents want the same message, the one higher in the list takes it.

## From 0.7

- Playbooks were cut before 0.7 shipped, so there is nothing to migrate. 0008 adds agents and `draft_notes.agent`.
- Auto-draft becomes the PluraMail Agent's fallback for mail no agent takes.
- Runs, draft notes, redraft, logs, safety checks and send limits stay as built.

## First agents to ship

Decline pitches, ask for missing details, acknowledge new senders, answer FAQs.

## Releases

- 0.9: console, agents in Watch and Draft, Draft review, MCP page, MCP sign-in with OAuth 2.1 and a separate send grant.
- 0.10: the workbench (setup beside what the agent does), Test on past mail, promotion evidence, then Send.

## Build order

1. Console page and navigation (0.9.0)
2. Agents in Watch and Draft, and Review (0.9.0)
3. Test on past mail (0.10)
4. Send (0.10)
