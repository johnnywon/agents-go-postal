// Test-only worker: the same store calls against the Durable Object store and the D1 store.
export { MailboxDO } from "../../workers/durableObject";
export { MailIndexDO } from "../../workers/durableObject/mail-index";
import { durableObjectInternals, mailStore } from "../../workers/store";
import type { Env } from "../../workers/types";

export default {
	async fetch(request: Request, env: Env & { DB: D1Database }) {
		const { store, target, op, args = [] } = (await request.json()) as { store: "do" | "d1"; target: string; op: string; args?: unknown[] };
		try {
			if (op === "_sql") {
				const result = await env.DB.prepare(String(args[0])).run();
				return Response.json({ ok: result.success });
			}
			if (op === "_teach") {
				await durableObjectInternals(env).mailbox(target).setMailboxId(target);
				return Response.json({ ok: true });
			}
			const stores = mailStore({ ...env, STORAGE: store === "d1" ? "d1" : "" } as Env);
			const obj = (target === "all" ? stores.all() : stores.mailbox(target)) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
			return Response.json({ ok: (await obj[op](...args)) ?? null });
		} catch (e) {
			return Response.json({ error: (e as Error).message });
		}
	},
};
