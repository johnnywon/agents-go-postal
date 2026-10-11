# D1 bench

Measures what `docs/d1-phase0.md` reports: write speed, index size, batch limits and search speed on a real D1 database.

1. `npx wrangler d1 create agp-d1-bench`, then put your account id and the database id in `wrangler.jsonc`.
2. `npx wrangler dev --remote -c scripts/d1-bench/wrangler.jsonc --port 8799`
3. `curl localhost:8799/schema`, then seed in steps of 2,000:
   `for f in $(seq 0 2000 98000); do curl -s "localhost:8799/seed?from=$f&count=2000&batch=200"; echo; done`
4. `curl localhost:8799/rank-config`, then time searches:
   `curl "localhost:8799/suggest-v4?q=invoice"`, `curl "localhost:8799/suggest-v2?q=invoice&cap=5000"`, `curl localhost:8799/list`.
5. Limits: `curl "localhost:8799/batchlimit?stmts=20000"`, `curl "localhost:8799/valuelimit?bytes=8000000"`.

Delete the database when done: `npx wrangler d1 delete agp-d1-bench`. The `/suggest-capped` route is kept as the counter-example: it runs `MATCH` twice on the same table in one statement and hits D1's CPU limit at 100,000 messages.
