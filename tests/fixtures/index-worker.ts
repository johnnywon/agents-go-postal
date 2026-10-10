// Test-only worker: exposes the two Durable Objects over a JSON RPC shim for Miniflare tests.
export { MailboxDO } from "../../workers/durableObject";
export { MailIndexDO } from "../../workers/durableObject/mail-index";
import { dryRunFolderImport, importDeps, runFolderImport } from "../../workers/lib/folder-import";
import type { Env } from "../../workers/types";

interface TestEnv {
	MAILBOX: DurableObjectNamespace;
	MAIL_INDEX: DurableObjectNamespace;
	BUCKET: R2Bucket;
}

export default {
	async fetch(request: Request, env: TestEnv) {
		const { target, op, args = [] } = (await request.json()) as { target: string; op: string; args?: unknown[] };
		try {
			if (target === "folders") {
				const deps = importDeps(env as unknown as Env);
				return Response.json({ ok: op === "run" ? await runFolderImport(deps) : await dryRunFolderImport(deps) });
			}
			if (target === "bucket-get") {
				const object = await env.BUCKET.get(String(args[0]));
				return Response.json({ ok: object ? await object.json() : null });
			}
			if (target === "bucket-raw") {
				await env.BUCKET.put(String(args[0]), String(args[1]));
				return Response.json({ ok: true });
			}
			if (target === "bucket-head") {
				return Response.json({ ok: (await env.BUCKET.head(String(args[0]))) !== null });
			}
			if (target === "bucket") {
				await env.BUCKET.put(`mailboxes/${args[0]}.json`, "{}");
				return Response.json({ ok: true });
			}
			const ns = target === "index" ? env.MAIL_INDEX : env.MAILBOX;
			const stub = ns.get(ns.idFromName(target === "index" ? "global" : target)) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
			return Response.json({ ok: await stub[op](...args) });
		} catch (e) {
			return Response.json({ error: (e as Error).message });
		}
	},
};
