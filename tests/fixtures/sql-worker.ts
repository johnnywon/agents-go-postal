// Test-only worker: runs d1Sql against a Miniflare D1 binding.
import { d1Sql } from "../../workers/store/sql";

export default {
	async fetch(request: Request, env: { DB: D1Database }) {
		const sql = d1Sql(env.DB);
		const { op, args = [] } = (await request.json()) as { op: "all" | "first" | "run" | "batch"; args?: unknown[] };
		try {
			const fn = sql[op] as (...a: unknown[]) => Promise<unknown>;
			return Response.json({ ok: await fn(...args) });
		} catch (e) {
			return Response.json({ error: (e as Error).message });
		}
	},
};
