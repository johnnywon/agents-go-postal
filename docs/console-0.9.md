# Console 0.9

Not built yet. WON-231 and WON-209.

## In one line

Each agent does one job on the addresses you choose. It starts in Watch, moves to Draft, then to Send once you trust it.

## Pages

| Page | What's on it |
|---|---|
| Home | Today's counts and agents worth a look |
| Agents | Every agent: name, job, addresses, mode. The PluraMail Agent is the built-in one. |
| Review | Drafts waiting for you |
| Logs | Every action by an agent or a tool |
| Tool keys | Keys that let apps like Claude Desktop use your mail over MCP |
| Models | The default model and the provider keys that pay for it |
| Mail settings | The 0.7 settings tabs |

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
- Each agent has a daily limit and a limit of two replies a day to one sender.
- When two agents want the same message, the one higher in the list takes it.

## From 0.7

- Playbooks were cut before 0.7 shipped, so there is nothing to migrate. 0008 adds agents and `draft_notes.agent`.
- Auto-draft becomes the PluraMail Agent's fallback for mail no agent takes.
- Runs, draft notes, redraft, logs, safety checks and send limits stay as built.

## First agents to ship

Decline pitches, ask for missing details, acknowledge new senders, answer FAQs.

## Releases

- 0.9: console, agents in Watch and Draft, Draft review, MCP page.
- 0.10: the workbench (setup beside what the agent does), Test on past mail, promotion evidence, then Send.
- 0.11: tool keys.

## Build order

1. Console page and navigation
2. Agents in Watch and Draft, and Review
3. Test on past mail
4. Send
5. Tool keys
