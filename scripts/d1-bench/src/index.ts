// Phase 0 bench for the D1 plan. Throwaway. Run with `wrangler dev --remote`.
interface Env { DB: D1Database }

const WORDS = ("invoice receipt payment order shipped delivery tracking account password reset security alert login " +
	"meeting agenda notes schedule call tomorrow monday friday quarterly report numbers revenue forecast budget " +
	"contract draft review signature legal terms renewal notice subscription plan upgrade trial cancel refund " +
	"lunch dinner golf tee time confirmed booking reservation flight hotel travel itinerary passport visa " +
	"project launch release deploy build failed passed pull request merge branch issue ticket support customer " +
	"thanks please regards hello hi team update question follow up attached document spreadsheet slides photo " +
	"family school weekend birthday party gift holiday vacation weather garden house rent mortgage insurance " +
	"newsletter digest weekly monthly offer discount sale coupon free shipping limited new product feature").split(" ");
const DOMAINS = ["example.com", "example.org", "example.net", "stripe.example", "github.example", "bank.example", "airline.example", "school.example"];
const MAILBOXES = ["hello@example.com", "billing@example.com", "support@example.org", "ops@example.net"];

function rng(seed: number) {
	let s = seed >>> 0;
	return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
// Zipf-ish word pick so the vocabulary looks like real text.
const pick = (r: () => number, list: string[]) => list[Math.floor(list.length * r() ** 2.2)];

function message(i: number) {
	const r = rng(i * 7919 + 13);
	const sender = `${pick(r, ["ann", "bob", "maria", "billing", "noreply", "news", "ops", "li", "sam", "kai"])}${Math.floor(r() * 60)}@${pick(r, DOMAINS)}`;
	const subject = Array.from({ length: 3 + Math.floor(r() * 6) }, () => pick(r, WORDS)).join(" ");
	const words = 300 + Math.floor(r() * 900); // ~2 to 7 KB of text
	const body = Array.from({ length: words }, (_, k) => (k % 14 === 13 ? `${pick(r, WORDS)}.` : pick(r, WORDS))).join(" ");
	const date = new Date(Date.UTC(2024, 0, 1) + Math.floor(r() * 650 * 86400_000)).toISOString();
	return { id: `m${i}`, mailbox: MAILBOXES[i % MAILBOXES.length], sender, domain: sender.split("@")[1], subject, body, date,
		code: `INV-${10000 + (i % 90000)}`, attachment: r() < 0.2 ? `${pick(r, WORDS)}-${i}.pdf` : "" };
}

const SCHEMA = [
	`CREATE TABLE IF NOT EXISTS messages (rowid INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, mailbox_id TEXT NOT NULL, folder_id TEXT NOT NULL,
		thread_id TEXT NOT NULL, date TEXT NOT NULL, subject TEXT NOT NULL, sender TEXT NOT NULL, sender_domain TEXT NOT NULL,
		recipient TEXT NOT NULL, snippet TEXT NOT NULL, body TEXT, read INTEGER NOT NULL DEFAULT 0, has_attachment INTEGER NOT NULL DEFAULT 0)`,
	`CREATE INDEX IF NOT EXISTS messages_folder_date ON messages (mailbox_id, folder_id, date DESC)`,
	`CREATE INDEX IF NOT EXISTS messages_date ON messages (date DESC)`,
	`CREATE INDEX IF NOT EXISTS messages_sender ON messages (sender)`,
	`CREATE INDEX IF NOT EXISTS messages_sender_domain ON messages (sender_domain)`,
	`CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(subject, sender, recipient, attachment_names, body_text, tokenize='unicode61 remove_diacritics 2', prefix='2 3')`,
	`CREATE VIRTUAL TABLE IF NOT EXISTS messages_trigram USING fts5(subject, sender, recipient, attachment_names, tokenize='trigram')`,
	`CREATE VIRTUAL TABLE IF NOT EXISTS messages_vocab USING fts5vocab(messages_fts, 'row')`,
];

function insertStatements(db: D1Database, i: number, opts: { fts: boolean }) {
	const m = message(i);
	const subject = `${m.subject} ${m.code}`;
	const out = [db.prepare(`INSERT OR IGNORE INTO messages (rowid, id, mailbox_id, folder_id, thread_id, date, subject, sender, sender_domain, recipient, snippet, body, has_attachment)
		VALUES (?, ?, ?, 'inbox', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(i, m.id, m.mailbox, `t${Math.floor(i / 3)}`, m.date, subject, m.sender, m.domain, m.mailbox, m.body.slice(0, 160), `<p>${m.body}</p>`, m.attachment ? 1 : 0)];
	if (opts.fts) {
		out.push(db.prepare(`INSERT INTO messages_fts (rowid, subject, sender, recipient, attachment_names, body_text) VALUES (?, ?, ?, ?, ?, ?)`).bind(i, subject, m.sender, m.mailbox, m.attachment, m.body));
		out.push(db.prepare(`INSERT INTO messages_trigram (rowid, subject, sender, recipient, attachment_names) VALUES (?, ?, ?, ?, ?)`).bind(i, subject, m.sender, m.mailbox, m.attachment));
	}
	return out;
}

async function timed<T>(fn: () => Promise<T>) {
	const t = Date.now();
	const result = await fn();
	return { ms: Date.now() - t, result };
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const n = (k: string, d: number) => Number(url.searchParams.get(k) ?? d);
		try {
			if (url.pathname === "/schema") {
				await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)));
				return Response.json({ ok: true });
			}
			// Insert messages [from, from+count) in batches of `batch` messages.
			if (url.pathname === "/seed") {
				const from = n("from", 0), count = n("count", 1000), batch = n("batch", 200), fts = url.searchParams.get("fts") !== "0";
				const times: number[] = [], sql: number[] = [];
				for (let i = from; i < from + count; i += batch) {
					const stmts = [];
					for (let j = i; j < Math.min(i + batch, from + count); j++) stmts.push(...insertStatements(env.DB, j, { fts }));
					const { ms, result } = await timed(() => env.DB.batch(stmts));
					times.push(ms);
					sql.push(result.reduce((a, r) => a + (r.meta?.duration ?? 0), 0));
				}
				const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
				return Response.json({ from, count, batch, fts, batches: times.length, wallMs: sum(times), sqlMs: Math.round(sum(sql)), perMessageWallMs: +(sum(times) / count).toFixed(2), maxBatchMs: Math.max(...times) });
			}
			// Backfill FTS for rows that were seeded without it.
			if (url.pathname === "/backfill") {
				const from = n("from", 0), to = n("to", 1000), table = url.searchParams.get("table") ?? "fts";
				const sql = table === "fts"
					? `INSERT INTO messages_fts (rowid, subject, sender, recipient, attachment_names, body_text) SELECT rowid, subject, sender, recipient, '', body FROM messages WHERE rowid >= ? AND rowid < ?`
					: `INSERT INTO messages_trigram (rowid, subject, sender, recipient, attachment_names) SELECT rowid, subject, sender, recipient, '' FROM messages WHERE rowid >= ? AND rowid < ?`;
				const { ms, result } = await timed(() => env.DB.prepare(sql).bind(from, to).run());
				return Response.json({ ms, meta: result.meta });
			}
			// One inbound message: message + FTS + trigram + 2 attachment rows in one batch.
			if (url.pathname === "/inbound") {
				const i = n("i", 900000);
				const stmts = insertStatements(env.DB, i, { fts: true });
				const { ms, result } = await timed(() => env.DB.batch(stmts));
				return Response.json({ ms, sqlMs: result.reduce((a, r) => a + (r.meta?.duration ?? 0), 0), rowsWritten: result.reduce((a, r) => a + (r.meta?.rows_written ?? 0), 0) });
			}
			// Largest batch: `stmts` tiny statements, or `bytes` of payload spread over `stmts` statements.
			if (url.pathname === "/batchlimit") {
				const stmts = n("stmts", 100), bytes = n("bytes", 0);
				await env.DB.prepare(`CREATE TABLE IF NOT EXISTS blob_test (id INTEGER PRIMARY KEY, v TEXT)`).run();
				const each = bytes ? Math.ceil(bytes / stmts) : 1;
				const value = "x".repeat(each);
				const list = Array.from({ length: stmts }, (_, k) => env.DB.prepare(`INSERT OR REPLACE INTO blob_test (id, v) VALUES (?, ?)`).bind(k, value));
				const { ms } = await timed(() => env.DB.batch(list));
				await env.DB.prepare(`DELETE FROM blob_test`).run();
				return Response.json({ ok: true, stmts, bytesPerStmt: each, ms });
			}
			// Largest single value.
			if (url.pathname === "/valuelimit") {
				const bytes = n("bytes", 1_000_000);
				await env.DB.prepare(`CREATE TABLE IF NOT EXISTS blob_test (id INTEGER PRIMARY KEY, v TEXT)`).run();
				const { ms } = await timed(() => env.DB.prepare(`INSERT OR REPLACE INTO blob_test (id, v) VALUES (1, ?)`).bind("x".repeat(bytes)).run());
				await env.DB.prepare(`DELETE FROM blob_test`).run();
				return Response.json({ ok: true, bytes, ms });
			}
			// The search window's one round trip: top results with snippets, narrowing facets, completions.
			if (url.pathname === "/suggest") {
				const q = url.searchParams.get("q") ?? "invoice";
				const match = q.split(/\s+/).filter(Boolean).map((t) => `"${t.replace(/"/g, '""')}"*`).join(" AND ");
				const prefix = (url.searchParams.get("from") ?? "bil").toLowerCase();
				const stmts = [
					env.DB.prepare(`SELECT m.id, m.subject, m.sender, m.date, snippet(messages_fts, -1, char(2), char(3), '…', 18) AS snip
						FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid
						WHERE messages_fts MATCH ? ORDER BY bm25(messages_fts, 6, 3, 2, 2, 1) LIMIT 6`).bind(match),
					env.DB.prepare(`SELECT m.sender_domain, count(*) AS n FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid
						WHERE messages_fts MATCH ? GROUP BY m.sender_domain ORDER BY n DESC LIMIT 5`).bind(match),
					env.DB.prepare(`SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH ?`).bind(match),
					env.DB.prepare(`SELECT sender, count(*) AS n FROM messages WHERE sender >= ? AND sender < ? GROUP BY sender ORDER BY n DESC LIMIT 6`).bind(prefix, `${prefix}￿`),
				];
				const { ms, result } = await timed(() => env.DB.batch(stmts));
				return Response.json({ q, wallMs: ms, sqlMs: result.map((r) => +(r.meta?.duration ?? 0).toFixed(2)), rowsRead: result.map((r) => r.meta?.rows_read), total: (result[2].results[0] as { n: number }).n, top: result[0].results.slice(0, 2) });
			}
			// Same round trip, but ranking and facets only look at the newest `cap` matches.
			if (url.pathname === "/suggest-capped") {
				const q = url.searchParams.get("q") ?? "invoice";
				const cap = n("cap", 5000);
				const match = q.split(/\s+/).filter(Boolean).map((t) => `"${t.replace(/"/g, '""')}"*`).join(" AND ");
				const recent = `SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?1 ORDER BY rowid DESC LIMIT ?2`;
				const stmts = [
					env.DB.prepare(`SELECT m.id, m.subject, snippet(messages_fts, -1, char(2), char(3), '…', 18) AS snip
						FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid
						WHERE messages_fts MATCH ?1 AND messages_fts.rowid IN (${recent})
						ORDER BY bm25(messages_fts, 6, 3, 2, 2, 1) LIMIT 6`).bind(match, cap),
					env.DB.prepare(`SELECT m.sender_domain, count(*) AS n FROM messages m WHERE m.rowid IN (${recent}) GROUP BY m.sender_domain ORDER BY n DESC LIMIT 5`).bind(match, cap),
					env.DB.prepare(`SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH ?`).bind(match),
				];
				const { ms, result } = await timed(() => env.DB.batch(stmts));
				return Response.json({ q, cap, wallMs: ms, sqlMs: result.map((r) => +(r.meta?.duration ?? 0).toFixed(2)), total: (result[2].results[0] as { n: number }).n });
			}
			if (url.pathname === "/rank-config") {
				await env.DB.prepare(`INSERT INTO messages_fts(messages_fts, rank) VALUES('rank', 'bm25(6.0, 3.0, 2.0, 2.0, 1.0)')`).run();
				return Response.json({ ok: true });
			}
			// Rank inside FTS5 (configured rank), join only the top rows; facets over the newest `cap` matches.
			if (url.pathname === "/suggest-v2") {
				const q = url.searchParams.get("q") ?? "invoice";
				const cap = n("cap", 5000);
				const match = q.split(/\s+/).filter(Boolean).map((t) => `"${t.replace(/"/g, '""')}"*`).join(" AND ");
				const stmts = [
					env.DB.prepare(`WITH top AS (
							SELECT rowid, rank, snippet(messages_fts, -1, char(2), char(3), '…', 18) AS snip
							FROM messages_fts WHERE messages_fts MATCH ?1 ORDER BY rank LIMIT 6)
						SELECT m.id, m.subject, top.snip FROM top JOIN messages m ON m.rowid = top.rowid ORDER BY top.rank`).bind(match),
					env.DB.prepare(`SELECT m.sender_domain, count(*) AS n FROM messages m
						WHERE m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?1 ORDER BY rowid DESC LIMIT ?2)
						GROUP BY m.sender_domain ORDER BY n DESC LIMIT 5`).bind(match, cap),
					env.DB.prepare(`SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH ?`).bind(match),
					env.DB.prepare(`WITH top AS (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?1 ORDER BY rowid DESC LIMIT 6)
						SELECT m.id, m.date FROM top JOIN messages m ON m.rowid = top.rowid`).bind(match),
				];
				const { ms, result } = await timed(() => env.DB.batch(stmts));
				return Response.json({ q, cap, wallMs: ms, sqlMs: result.map((r) => +(r.meta?.duration ?? 0).toFixed(2)), rowsRead: result.map((r) => r.meta?.rows_read), total: (result[2].results[0] as { n: number }).n });
			}
			// Rank only among the newest `cap` matches, using a rowid floor FTS5 applies natively.
			if (url.pathname === "/suggest-v3") {
				const q = url.searchParams.get("q") ?? "invoice";
				const cap = n("cap", 5000);
				const match = q.split(/\s+/).filter(Boolean).map((t) => `"${t.replace(/"/g, '""')}"*`).join(" AND ");
				const t0 = Date.now();
				const floorRow = await env.DB.prepare(`SELECT rowid FROM messages_fts WHERE messages_fts MATCH ? ORDER BY rowid DESC LIMIT 1 OFFSET ?`).bind(match, cap - 1).first<{ rowid: number }>();
				const floor = floorRow?.rowid ?? 0;
				const t1 = Date.now();
				const stmts = [
					env.DB.prepare(`WITH top AS (
							SELECT rowid, rank, snippet(messages_fts, -1, char(2), char(3), '…', 18) AS snip
							FROM messages_fts WHERE messages_fts MATCH ?1 AND rowid >= ?2 ORDER BY rank LIMIT 6)
						SELECT m.id, m.subject, top.snip FROM top JOIN messages m ON m.rowid = top.rowid ORDER BY top.rank`).bind(match, floor),
					env.DB.prepare(`SELECT m.sender_domain, count(*) AS n FROM messages_fts f JOIN messages m ON m.rowid = f.rowid
						WHERE messages_fts MATCH ?1 AND f.rowid >= ?2 GROUP BY m.sender_domain ORDER BY n DESC LIMIT 5`).bind(match, floor),
					env.DB.prepare(`SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH ?`).bind(match),
				];
				const { ms, result } = await timed(() => env.DB.batch(stmts));
				return Response.json({ q, cap, floorMs: t1 - t0, batchMs: ms, wallMs: Date.now() - t0, sqlMs: result.map((r) => +(r.meta?.duration ?? 0).toFixed(2)), total: (result[2].results[0] as { n: number }).n, top: (result[0].results[0] as { snip?: string })?.snip?.slice(0, 80) });
			}
			// Rank without snippets, then snippets for the six winners only.
			if (url.pathname === "/suggest-v4") {
				const q = url.searchParams.get("q") ?? "invoice";
				const match = q.split(/\s+/).filter(Boolean).map((t) => `"${t.replace(/"/g, '""')}"*`).join(" AND ");
				const t0 = Date.now();
				const ranked = await env.DB.prepare(`SELECT rowid FROM messages_fts WHERE messages_fts MATCH ? ORDER BY rank LIMIT 6`).bind(match).all<{ rowid: number }>();
				const t1 = Date.now();
				const ids = JSON.stringify(ranked.results.map((r) => r.rowid));
				const snips = await env.DB.prepare(`SELECT f.rowid, m.subject, snippet(messages_fts, -1, char(2), char(3), '…', 18) AS snip
					FROM messages_fts f JOIN messages m ON m.rowid = f.rowid
					WHERE messages_fts MATCH ?1 AND f.rowid IN (SELECT value FROM json_each(?2))`).bind(match, ids).all();
				const t2 = Date.now();
				const recent = await env.DB.prepare(`SELECT rowid FROM messages_fts WHERE messages_fts MATCH ? ORDER BY rowid DESC LIMIT 6`).bind(match).all();
				const t3 = Date.now();
				return Response.json({ q, rankMs: t1 - t0, rankSql: +ranked.meta.duration.toFixed(2), snipMs: t2 - t1, snipSql: +snips.meta.duration.toFixed(2), newestMs: t3 - t2, newestSql: +recent.meta.duration.toFixed(2), rows: snips.results.length });
			}
			// The plain list, newest first, for comparison.
			if (url.pathname === "/list") {
				const { ms, result } = await timed(() => env.DB.prepare(`SELECT id, subject, sender, date, snippet FROM messages WHERE mailbox_id = ? AND folder_id = 'inbox' ORDER BY date DESC LIMIT 50`).bind(MAILBOXES[0]).all());
				return Response.json({ wallMs: ms, sqlMs: result.meta.duration, rowsRead: result.meta.rows_read });
			}
			if (url.pathname === "/trigram") {
				const q = url.searchParams.get("q") ?? "V-204";
				const { ms, result } = await timed(() => env.DB.prepare(`SELECT count(*) AS n FROM messages_trigram WHERE messages_trigram MATCH ?`).bind(`"${q}"`).all());
				return Response.json({ wallMs: ms, sqlMs: result.meta.duration, rows: result.results });
			}
			if (url.pathname === "/vocab") {
				const t = url.searchParams.get("t") ?? "invo";
				const { ms, result } = await timed(() => env.DB.prepare(`SELECT term, doc FROM messages_vocab WHERE term >= ? AND term < ? ORDER BY doc DESC LIMIT 20`).bind(t.slice(0, 2), `${t.slice(0, 2)}￿`).all());
				return Response.json({ wallMs: ms, sqlMs: result.meta.duration, terms: result.results.length });
			}
			if (url.pathname === "/count") {
				const r = await env.DB.prepare(`SELECT count(*) AS n FROM messages`).first();
				return Response.json(r);
			}
			return new Response("not found", { status: 404 });
		} catch (e) {
			return Response.json({ error: (e as Error).message }, { status: 500 });
		}
	},
};
