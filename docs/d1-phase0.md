# D1 phase 0 results

2026-10-11. Answers to the unknowns in [the D1 plan](d1-migration-plan.md#phase-0-results). Run against a real D1 database on the account that hosts the reference deployment (Workers Paid, since it sends mail), from `wrangler dev --remote` and one deployed throwaway Worker. The bench is in `scripts/d1-bench/`.

**Test data.** 100,400 synthetic messages across 4 addresses. Each body is 300 to 1,200 words, about 4.9 KB of text, stored as HTML. Words come from a vocabulary of about 190 words, so a common word appears in almost every message. That makes broad searches a worst case: real mail has a much larger vocabulary, and a word matches far fewer messages. The search times below are upper bounds for broad words. Phase 2 should repeat them on a copy of real mail.

## 1. FTS5 features

All of these work on D1:

- `unicode61 remove_diacritics 2` with `prefix='2 3'`
- `bm25()` with column weights, and a configured `rank`
- `snippet()` and `highlight()`
- contentless tables with `contentless_delete=1`
- the `trigram` tokenizer, for both `MATCH` and `LIKE '%…%'`
- `fts5vocab`
- `json_each(?)` for id lists
- `INSERT … ON CONFLICT DO NOTHING RETURNING`

`sqlite_version()` is blocked ("not authorized to use function"), so the version can't be read. Check features directly.

## 2. Export

`wrangler d1 export` refuses the whole database: "cannot export databases with virtual tables (like FTS5)". Exporting one table with `--table <name>` works. An export can be built from per-table exports of every regular table, followed by an FTS rebuild after import. The app also needs its own `GET /api/v1/export`. Time Travel covers backups.

## 3. Write speed and size

| Measurement | Result |
|---|---|
| Bulk import, batches of 200 messages (message + word index + trigram rows) | 1.66 ms per message on average. It rose from 1.2 ms to 2.0 ms as the database grew to 100,000. Slowest batch: 790 ms. |
| Bulk import, message rows only | 0.49 to 0.66 ms per message |
| 100,000 messages with indexes | 149 seconds |
| One inbound message (message + word index + trigram, one batch) | About 32 ms from the Worker, 0.6 to 1.0 ms of SQL, 8 rows written |

Size per message:

| Part | KB per message |
|---|---|
| Message row and its indexes (HTML body included) | 6.9 |
| Word index that stores its own text | 10.2 |
| Word index, contentless (today's design) | 3.9 |
| Trigram index (subject, sender, recipient, attachment names) | 0.4 |

With a contentless word index, a message costs about 11 KB, so 10 GB holds about 900,000 messages of this size. With a text-storing index it's about 17.5 KB, or roughly 560,000 messages.

## 4. Batch and value limits

| Limit | Result |
|---|---|
| Statements in one `batch()` | 20,000 small statements worked (1.9 s). No statement-count limit was hit. |
| Payload of one `batch()` | 10 MB worked. 50 MB failed: "Serialized RPC arguments or return values are limited to 32MiB". |
| One value | 8 MB worked. 9 MB failed with `SQLITE_TOOBIG`. The plan's "2 MB" was wrong. |
| A query that runs too long | A ranking query that ran `MATCH` twice on the same table (once outside, once in a `rowid IN (…)` subquery) failed six times in a row: "D1 DB exceeded its CPU time limit and was reset". With a smaller subquery limit it finished, in 28 s. |

## 5. Cron beside email and Durable Objects

A deployed Worker with `triggers.crons: ["* * * * *"]`, an `email()` handler, a SQLite Durable Object and a D1 binding deployed without errors. Its cron fired at 15:03:28 and 15:04:28 UTC, and each run called the Durable Object and wrote to D1.

Not checked: cron limits on the Free plan. Sending mail already needs Workers Paid, so this matters only for a deployment that never sends.

## 6. Search speed at 100,000 messages

SQL time as D1 reports it (`meta.duration`). Wall time from the Worker adds 8 to 15 ms per round trip.

| Query | Matches | SQL time |
|---|---|---|
| Newest 50 in one address's inbox | | 0.4 to 3.6 ms |
| Rank by `bm25`, top 6 | 2 | 0.4 to 1 ms |
| Rank by `bm25`, top 6 | 158 | 1.4 to 14 ms |
| Rank by `bm25`, top 6 | 9,800 to 13,000 | 21 to 44 ms |
| Rank by `bm25`, top 6 | 94,000 to 100,000 | 222 to 458 ms |
| Newest 6 matches (`ORDER BY rowid DESC`) | 100,000 | 10 to 39 ms |
| Count matches | 100,000 | 15 to 34 ms |
| Sender facets over the newest 5,000 matches | 100,000 | 25 to 45 ms |
| `snippet()` for 6 known rows (`MATCH` plus `rowid IN`) | 100,000 | 57 to 160 ms |
| Trigram, a code fragment (`"V-2041"`) | 10 | 0.9 ms |
| Trigram, `ripe` | 8,980 | 1.6 ms |
| Vocabulary lookup by two-letter prefix | | 15 ms |

What this means:

- Ranking time grows with the number of matches. The largest measured mid point, 13,000 matches, stayed under 50 ms; 20,000 is an extrapolation. At 100,000 it takes 0.22 to 0.46 s.
- Newest-first is cheap at any match count, because FTS5 walks rowids in order.
- `snippet()` re-runs the match, so it costs as much as the match itself on broad words. Snippets for the rows on screen are cheaper to build in the Worker from the message body.
- Facets over all matches cost 280 ms at 100,000 matches. Limited to the newest 5,000 they cost 25 to 45 ms.

## 7. Local development

`wrangler dev` with a local D1 and the remote `send_email` binding starts and runs together. The word index, `rank`, trigram and vocabulary all work locally. Local import ran at 0.35 ms per message.

## Changes to the plan

1. **Keep the word index contentless**, as today. It is 62% smaller (3.9 KB against 10.2 KB per message). Build snippets in the Worker: strip the body to text for the rows on screen, find the query terms, and mark them. Drop `snippet()` and `highlight()` from the SQL.
2. **Ranking rule.** Count matches first (15 to 34 ms). With 20,000 or fewer, sort by relevance. Confirm the 20,000 line on real mail in phase 2. With more, sort newest first, and offer "Sort by relevance" as an explicit action that takes about half a second.
3. **Facets** count over the newest 5,000 matches, through `rowid IN (SELECT rowid … ORDER BY rowid DESC LIMIT 5000)`, never a join against every match.
4. **One `MATCH` per statement.** A statement that ran `MATCH` twice on the same table hit D1's CPU limit and reset the database. A single `MATCH` inside an uncorrelated `IN (…)` subquery, as the capped facets use, was fast. Add a test that fails on that pattern in `workers/store/search.ts`.
5. **Value limit is about 8 MB, not 2 MB.** Keep bodies over 512 KB in R2 anyway: it keeps rows small and reads fast.
6. **Size batches by bytes, not statements.** Stay under 24 MB of payload per `batch()`. Batches of 200 messages are a good default.
7. **Export** uses per-table `wrangler d1 export --table` plus the app's own export route.

## Cleanup

- The throwaway cron Worker `agp-phase0-cron` is deleted.
- The D1 database `agp-phase0` still exists. It holds 1.8 GB of synthetic mail (18.2 KB per message across every table, which matches the per-part sizes above). It can be deleted, or kept to re-run the bench.

## Drift check

2026-10-11, against the raw bench output from this session. Corrected:

1. The CPU-limit failure was blamed on a `MATCH` in a subquery. The query actually ran `MATCH` twice on the same table; a single `MATCH` in a subquery was fast. The rule is now "one `MATCH` per statement".
2. It said one query failed. Six failed in a row at a 5,000-row limit; one finished in 28 s at a 1,000-row limit.
3. "Under 50 ms up to about 20,000 matches" overstated the data. The largest mid point measured was 13,000 matches. 20,000 is marked as an extrapolation to confirm on real mail.
4. Removed "the first cron run came about four minutes after deploy": the deploy time wasn't recorded.
5. Small number fixes: message-only import 0.49 (not 0.5) to 0.66 ms; text-storing capacity about 560,000 (not 570,000) messages; 100,000-match ranking 0.22 to 0.46 s (not 0.25 to 0.45 s).

Every other figure matches the output it came from.

