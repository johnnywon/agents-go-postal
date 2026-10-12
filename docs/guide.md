# Guide

How the app works day to day. Back to the [README](../README.md).

## Features

- **One list for every address.** Filter by address, domain, sender, label, date and status. Each domain gets its own colour and shape, so you can tell at a glance which address a message reached.
- **Full mail client.** Rich-text compose, reply, reply all, forward, drafts, attachments, folders, stars, search and message source view.
- **One composer.** New mail, replies and forwards share the same layout. Replies and forwards quote the original as HTML, with its styles and scripts removed.
- **Signatures.** One per address, set in Settings > Signatures. None is added unless you turn on "Add by default"; the signature button in the composer adds or removes it on any message.
- **Scheduled send.** Pick tomorrow morning, Monday morning or any future time. The message waits in Drafts until it goes out.
- **Labels and bulk actions.** Select many conversations to archive, delete, mark read, star, label or move. Undo is available after each action. Rename, recolour and delete labels in Settings > Labels, or from Manage labels in the sidebar.
- **Keyboard shortcuts** for navigation and actions.
- **Per-address isolation.** Every address has its own Durable Object, database and prompt settings.
- **AI agent.** A side panel that can read, search, label, draft and send using Workers AI, or any OpenRouter model with your own key. It searches and labels across every address at once (`search_all_mail`, `label_matching`, up to 500 conversations per call). "Draft reply" in either composer (or "Draft" in a new message) asks it for a first draft. Labels the agent has applied are marked with a sparkle. It sends a draft with `send_draft` when you ask it to. Automatic drafting of new mail is off by default (`AUTO_DRAFT_ENABLED`); it only drafts, and skips mailing lists, bulk mail, auto-replies and no-reply senders.
- **MCP server** for connecting outside agents, including `send_draft`.
- **Sends go out once.** Each send can carry an `Idempotency-Key` header. A retry with the same key returns the first send instead of sending again. The composer sets one per message, and every way of sending a saved draft uses `draft:<id>`, so a draft is sent once whether you, the agent or the schedule sends it.
- **Cloudflare Access required.** Outside local development the Worker refuses every request until Access is configured.

## The postal view

The mail view is a three-column workspace: mailboxes on the left, the list and reader in the middle, the agent on the right. Both side columns collapse to rails. Below 1300px the agent overlays the reader; at phone widths the app shows one pane at a time.

Preferences such as theme (dark, light or system), key hints, mark-as-read, remote images and reply-from-receiving-address are stored per browser. Display names and the agent prompt are stored with each mailbox.

Keyboard: `j`/`k` move, `e` archive, `x` select, `r` reply, `a` reply all, `f` forward, `c` new email, `z` undo, `/` or `⌘K` search, `⌘↵` send, `⌘J` agent, `Esc` close.

## Search

The search bar, the agent's `search_all_mail` and `search_emails`, and the MCP tools share one search language ([`shared/search-query.ts`](../shared/search-query.ts)). Words match any field by prefix. `"wire transfer"` matches a phrase, `-word` or `-from:example.com` excludes, and `a OR b` matches either.

| Operator | Matches |
|---|---|
| `from:` `to:` | A name, address or domain. In the search bar, `to:` with one of your addresses picks that address. |
| `cc:` | A copied recipient |
| `subject:` `filename:` | Words in the subject or an attachment name |
| `label:` | A label, by name |
| `in:` | `inbox`, `unread`, `starred`, `drafts`, `sent`, `archive`, `spam`, `trash`, `all` (everything but spam and trash), `anywhere`, or a folder name |
| `is:` | `unread`, `read`, `starred`, `scheduled`, `replied` |
| `has:` | `attachment`, `pdf`, `image`, `draft`, `unsubscribe` |
| `before:` `after:` | A date (`2026-01-31`, your local day) or an age (`30d`, `3w`, `2m`, `1y`) |
| `newer:` `older:` | An age |
| `larger:` `smaller:` | A size including attachments: `500k`, `5mb` |
| `list:` | A mailing list id |

Unknown operators are searched as plain words. An operator with a value that doesn't parse, such as `before:soon`, is left out and named in the search bar. `cc:`, `filename:`, `larger:`, `smaller:`, `is:scheduled`, `has:pdf`, `has:image` and `has:link` need D1 storage ([Moving to D1](setup.md#moving-to-d1)).

On D1, a search with words lists the best match first: subject matches count most, body text least, and near-ties go to newer mail. Each row shows the text around the matched words and how many messages in the conversation matched. `sort:date`, or Newest above the list, puts newest first. Over 20,000 matching messages the list is newest first, since ranking that many takes too long; `sort:relevance` ranks it anyway. A word of three or more letters that matches no word is searched as part of a word in subjects, addresses, attachment names and attachment text, so `7731` finds `XK7731Q`. When nothing matches, the window suggests a spelling. On the Durable Object store results are newest first.

With `ATTACHMENT_SEARCH` set to `true`, the text of PDF, Word, Excel, OpenDocument, text and CSV attachments up to 10 MB is searched with the body. The cron converts five files a minute, newest first, with Workers AI `toMarkdown` (text files are read directly) and keeps up to 64 KB of text per file. New mail is searchable as soon as it arrives and its attachments a minute or two later. Mail stored before the setting was on is converted the same way, newest first. When the match is in a file, the row shows the file's name and the text around the match. Turning the setting off stops new conversions; text already converted stays searchable.

The window under the search box shows recent searches (kept in this browser), the people you get the most mail from, filters and addresses. While you type it shows the top six results and filters that narrow them, and with the cursor in an operator it completes the value. `↑` `↓` move, `Tab` completes, `↵` opens the highlighted row or the first result, `⌘↵` runs the search without opening anything, and `Esc` closes the window, then clears the box. `? Operators` in its footer lists every operator.

When the text reads like a request ("unread newsletters from this week"), the window offers Turn into a search. That sends the text, today's date, your label names and your addresses, never mail, to the model once, and puts the search it makes in the box with a one-line explanation and Undo: `is:unread has:unsubscribe after:7d`. Nothing runs that you can't see. On Workers AI it uses `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, because the default agent model took 10 to 27 seconds; with OpenRouter chosen in Settings it uses that model. If the call fails, the words are searched as typed. Ask the agent about it opens the agent panel with the text instead.

`⌘S` or Save search in the window saves the search in the box. Saved searches appear in the window and the sidebar with the number of conversations each matches in All mail. The window's server side is `GET /api/v1/search/suggest` and `/api/v1/saved-searches`.

## Scheduled send

Choose a time from the arrow next to Send in the compose window. The message is saved to Drafts with a "Scheduled" badge, and the address's Durable Object sends it with an alarm at that time through the normal sending path. Cancel removes the schedule and keeps the draft. Editing or deleting the draft before the send time cancels it. A send that fails is retried every 15 minutes, up to three attempts; after that the draft stays in Drafts marked "Send failed". Attachments count toward a 1.5 MB limit per scheduled message.

On D1 storage ([Moving to D1](setup.md#moving-to-d1)), a one-minute cron sends scheduled mail instead of the alarm, so a message can go out up to a minute after its time.

## Agent model

The agent runs on Workers AI (`@cf/moonshotai/kimi-k2.5`) by default. To use OpenRouter instead, open Settings, then Model & key, choose OpenRouter, paste an API key and pick a model. Only models that can call tools are listed. Test sends one short prompt to check the key. The chat panel, "Draft reply" and auto-draft then use that model and bill your OpenRouter account. The prompt-injection check and the draft cleanup on incoming mail stay on Workers AI.

The key is stored in R2 at `config/agent-model.json`, which no route serves. The API returns only its last four characters. Anyone who can open the app can replace or remove it, so keep the app behind Access.

## Stack

- **Frontend:** React 19, React Router v7 (server rendered), Tailwind CSS, TanStack Query, Zustand, TipTap, `@cloudflare/kumo`
- **Backend:** Hono, Cloudflare Workers, Durable Objects (SQLite), R2, Email Routing, Email Sending
- **Agent:** Cloudflare Agents SDK, AI SDK v6, Workers AI or OpenRouter
- **Auth:** Cloudflare Access JWT validation
