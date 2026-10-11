// Test-only worker: the same store calls against the Durable Object store and the D1 store.
export { MailboxDO } from "../../workers/durableObject";
export { MailIndexDO } from "../../workers/durableObject/mail-index";
import { durableObjectInternals, mailStore } from "../../workers/store";
import { advanceCopy, copyStartError, copyStatus, mirrorInbound, startCopy } from "../../workers/store/copy-job";
import type { Env } from "../../workers/types";

export default {
	async fetch(request: Request, env: Env & { DB: D1Database }) {
		const { store, target, op, args = [] } = (await request.json()) as { store: "do" | "d1"; target: string; op: string; args?: unknown[] };
		try {
			if (op === "_sql") {
				const result = await env.DB.prepare(String(args[0])).run();
				return Response.json({ ok: result.success });
			}
			const scoped = { ...env, STORAGE: store === "d1" ? "d1" : "" } as Env;
			if (op === "_rows") return Response.json({ ok: (await env.DB.prepare(String(args[0])).all()).results });
			if (op === "_copyStartError") return Response.json({ ok: await copyStartError(scoped) });
			if (op === "_copyStart") return Response.json({ ok: await startCopy(scoped) ?? null });
			if (op === "_copyStatus") return Response.json({ ok: await copyStatus(scoped) });
			if (op === "_mirror") return Response.json({ ok: (await mirrorInbound(scoped, target, ...(args as [string, never, never]))) ?? null });
			if (op === "_advance") {
				// A clock that moves `tick` ms per reading, so a slice stops after a few pages.
				const { tick = 0, runMs, pageSize } = (args[0] ?? {}) as { tick?: number; runMs?: number; pageSize?: number };
				let t = Date.now();
				return Response.json({ ok: await advanceCopy(scoped, { now: () => (t += tick), runMs, pageSize }) });
			}
			if (op === "_internal") {
				const stub = durableObjectInternals(env).mailbox(target) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
				return Response.json({ ok: (await stub[String(args[0])](...args.slice(1))) ?? null });
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
