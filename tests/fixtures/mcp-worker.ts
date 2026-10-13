// Test-only worker: the MCP server at /mcp, plus routes that apply the schema and create a mailbox with mail.
export { EmailMCP } from "../../workers/mcp";
import { EmailMCP } from "../../workers/mcp";
import { mailStore } from "../../workers/store";
import type { Env } from "../../workers/types";

const mcp = EmailMCP.serve("/mcp", { binding: "EMAIL_MCP" });

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);
		if (url.pathname.startsWith("/mcp")) return mcp.fetch(request, env, ctx);
		if (url.pathname === "/_sql") {
			await env.DB.prepare(await request.text()).run();
			return Response.json({ ok: true });
		}
		if (url.pathname === "/_seed") {
			const { mailbox, emails } = (await request.json()) as { mailbox: string; emails: Record<string, unknown>[] };
			await mailStore(env).mailboxes.put(mailbox, {});
			const stub = mailStore(env).mailbox(mailbox);
			for (const email of emails) await stub.createEmail("inbox", email as never, []);
			return Response.json({ ok: true });
		}
		return new Response("Not found", { status: 404 });
	},
};
