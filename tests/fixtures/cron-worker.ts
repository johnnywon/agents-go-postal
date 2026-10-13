// Test-only worker: the cron's scheduled send on D1, with a fake email binding.
import { runCron } from "../../workers/cron";
import { mailStore } from "../../workers/store";
import type { Env } from "../../workers/types";

const sent: unknown[] = [];
let failing = false;
const EMAIL = {
	async send(message: unknown) {
		await new Promise((r) => setTimeout(r, 5)); // let overlapping runs interleave
		if (failing) throw new Error("binding down");
		sent.push(message);
	},
};

export default {
	async fetch(request: Request, base: Env & { DB: D1Database }) {
		const { op, args = [] } = (await request.json()) as { op: string; args?: unknown[] };
		const env = { ...base, EMAIL } as unknown as Env;
		try {
			switch (op) {
				case "_sql":
					return Response.json({ ok: (await base.DB.prepare(String(args[0])).run()).success });
				case "rows":
					return Response.json({ ok: (await base.DB.prepare(String(args[0])).all()).results });
				case "fail":
					failing = !!args[0];
					return Response.json({ ok: true });
				case "sent":
					return Response.json({ ok: sent.splice(0) });
				case "cron":
					return Response.json({ ok: await Promise.all(args.map((now) => runCron(env, Number(now)))) });
				case "register":
					await mailStore(env).mailboxes.put(String(args[0]), {});
					return Response.json({ ok: true });
				default: {
					const mailbox = mailStore(env).mailbox(String(args[0])) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
					return Response.json({ ok: (await mailbox[op](...args.slice(1))) ?? null });
				}
			}
		} catch (e) {
			return Response.json({ error: (e as Error).message });
		}
	},
};
