# Alex profile

A second sample inbox for demos: three weeks in the life of Alex Rivera, who runs Partwell, an API that normalizes manufacturers' product catalogs and serves them through MCP connectors. 47 messages across seven mailboxes. The code is `workers/lib/dev-seed/alex/`; the tests are `tests/dev-seed-alex.test.mjs` and `tests/dev-seed-alex-store.test.mjs`.

Partwell, its customers, vendors and Alex's friends are invented. GitHub, Cloudflare, Stripe, Supabase and Uber Eats appear as senders of simulated notices. None of that mail came from them, and writing the profile contacts nobody. Amounts, scores, case numbers and accounts are made up.

## Loading it

- Dev server: `SEED_PROFILE=alex` in `.dev.vars`. The first API request writes it into an empty database.
- On demand: `curl -X POST localhost:5173/api/v1/dev/seed -H 'content-type: application/json' -d '{"profile":"alex"}'`.
- Demo build: set `SEED_PROFILE` to `alex` in the demo's Wrangler `vars`, with `EMAIL_ADDRESSES` set to the seven addresses below and `DOMAINS` to `partwell.dev,alexrivera.me`.

The profile creates its seven mailboxes whatever `EMAIL_ADDRESSES` holds; the addresses are fixed, not mapped by position. Writing it again replaces only its own messages (ids start `seed-alex-v1-`) and their files. The default sample inbox and mail you made yourself stay. A demo's hourly reset wipes everything first, then writes the profile `SEED_PROFILE` names.

## Clock

Every message has a fixed time in New York, written against the story's own "now": Sunday, October 11, 2026 at 8:02 pm. On a later date the whole story moves forward in whole weeks, so weekdays and times of day stay as written: the incident runs 11:37 pm to 2:40 am, the league plays on Sundays. Dates inside bodies, quotes and attachments move with it. From February to August it moves in 52-week steps instead, to the last autumn, so the league stays in football season. The newest message is therefore between 4 minutes and a week old. The dev server writes the profile again when the week turns.

## Mailboxes

| Address | Messages | Inbox | Archive | Sent | Drafts | Spam | Trash | Unread |
|---|---|---|---|---|---|---|---|---|
| hello@partwell.dev | 5 | 3 | 1 | | | 1 | | H-04 (spam), H-05 |
| support@partwell.dev | 8 | 1 | 4 | 3 | | | | |
| billing@partwell.dev | 6 | 2 | 2 | 1 | 1 | | | B-04 |
| partners@partwell.dev | 6 | 2 | 2 | 1 | | | 1 | |
| ops@partwell.dev | 8 | 2 | 5 | 1 | | | | O-08 |
| alex@alexrivera.me | 8 | 2 | 5 | | 1 | | | A-06 |
| league@alexrivera.me | 6 | 3 | 2 | 1 | | | | L-06 |
| Total | 47 | 15 | 21 | 7 | 2 | 1 | 1 | 6 |

Drafts: B-06 (reply to Tess with `october-expenses.csv`) and A-08 (reply to Mara). Both open under their parent as Edit draft.

Starred: H-01, B-04, P-04, O-08, A-07, L-01.

Left open on purpose: Eli's connector question (H-05), the pagination fix awaiting June (SUP-05), the PO on PW-1068 (B-04), the expense reply (B-06), the license renewal (P-04), the next Cedar rollout stage (O-08), the migration reschedule (A-08).

## Threads

30 threads. Replies point at an earlier parent in the same mailbox, quote only the line they answer, and carry RFC `In-Reply-To` and `References`. A reply draft names its parent by stored id, as drafts the app saves do.

| Root | Messages | Story |
|---|---|---|
| SUP-01 | SUP-01, 02, 03 | `401 invalid_api_key`: trial key ID used in place of the live secret. Resolved. |
| SUP-04 | SUP-04, 05 | Cursor reused across a filter change; fixed in PR 184. Waiting on the customer. |
| SUP-06 | SUP-06, 07, 08 | Ben's timeouts during the incident; recovery at 2:36 am. Resolved. |
| B-01 | B-01, 02 | Northline's invoice PW-1042, $149.00. |
| B-05 | B-05, 06 | Tess's receipt questions; draft reply. |
| P-01 | P-01, 02, 03 | Atlas CAT-0930 renames `manufacturer_part_no` to `manufacturer_part_number`. |
| O-01 | O-01, 02 | PR 184 checks fail, then pass. |
| O-03 | O-03, 04, 07 | Latency alert 11:37 pm, throttling 11:38 pm, recovered 2:36 am. |
| O-05 | O-05, 06 | Database case DB-4821 and the provider's answer. |
| A-01 | A-01, 02 | Rice bowl UE-73102 and a same-price drink swap. |
| A-04 | A-04, 05 | Burrito UE-73419, confirmed 1:16 am, delivered 1:48 am, one charge. |
| A-07 | A-07, 08 | Migration review moved; draft reply. |
| L-04 | L-04, 05 | Jordan's round 2 roundup and Alex's reply. |

Single-message threads: H-01 to H-05, B-03, B-04, P-04, P-05, P-06, O-08, A-03, A-06, L-01, L-02, L-03, L-06.

## Facts the tests check

- Invoices: PW-1042 $149.00, PW-1068 $1,200.00 with PO CED-4417, tax $0.00 on both.
- Payout: gross $1,349.00, fees $39.12, net $1,309.88, dated after both charges.
- UE-73102: $11.95 food + $1.06 tax + $1.99 delivery + $0.87 service + $3.00 tip = $18.87.
- UE-73419: $13.50 food + $1.20 tax + $2.99 delivery + $1.50 service + $4.00 tip = $23.19, once.
- League: three rounds of results, standings computed from them (Priya 2–1 350.7, Nia 2–1 347.9, Ben 2–1 345.1, Alex 2–1 341.7, Jordan 1–2 357.0, Sam 1–2 346.0, Theo 1–2 322.4, Maya 1–2 320.8). Round 3: Alex 131.7, Jordan 130.9.
- Word counts for the slots that set one; at least 20 emoji in Jordan's L-04, none in the accountant's, the provider's or the alerts.

## Files

| Message | File | Type |
|---|---|---|
| H-02 | CED-4417-purchase-order.pdf | application/pdf |
| SUP-04 | pagination-repro.txt | text/plain |
| B-02 | PW-1042.pdf | application/pdf |
| B-06 | october-expenses.csv | text/csv |
| P-01 | CAT-0930-sample.csv | text/csv |
| P-04 | catalog-license-renewal.pdf | application/pdf |
| O-05 | connection-metrics.txt | text/plain |
| A-03 | keyboard.jpg | image/jpeg |
| A-05 | UE-73419-receipt.pdf | application/pdf |
| A-06 | flat-white.jpg (the coffee photo) | image/jpeg |

The PDFs are generated text PDFs; the CSVs and text files are plain UTF-8.

## Photos

Four openly licensed photos, stored once in `workers/lib/dev-seed/alex/assets/` with `manifest.json` (source page, download URL, creator, license, size, dimensions, SHA-256, changes). `scripts/seed-photos.mjs` writes them into `photos.ts` so the Worker carries the bytes; a test checks both against the manifest.

| Photo | Creator, license | Shown inline | As a file |
|---|---|---|---|
| football-stadium.jpg | carlinmack, CC0 1.0 | L-01, L-06 | |
| food-burrito.jpg | Wotancito, CC BY-SA 4.0 | A-04, A-05 | |
| coffee.jpg | www.Pixel.la Free Stock Photos, CC0 1.0 | H-03 | A-06 |
| keyboard.jpg | Anas Alshanti, CC0 1.0 | A-03 | A-03 |

Inline photos are real inline parts: `content_id` set, `disposition` inline, and `<img src="cid:…">` in the HTML, which the reader rewrites to the attachment URL. Each carries a credit line linking its source page and license. The burrito is a menu photo; the stadium is a 2019 college game, not an event the league went to.

## Links

Every link in the mail except a photo credit opens `/api/v1/sample-link`, a page in the app that shows where the link would go. That route exists only in dev and demo builds. The newsletter's `List-Unsubscribe` header names a buildnotes.news URL; the app reads it as metadata and never fetches it.
