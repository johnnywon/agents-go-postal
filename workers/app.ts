// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { routeAgentRequest } from "agents";
import { Hono } from "hono";
import { jwtVerify } from "jose";
import { createRequestHandler } from "react-router";
import { runCron } from "./cron";
import { accessConfigError, accessJwks, getAccessUrls } from "./lib/access-config";
import { errorResponse } from "./lib/error-page";
import { foreignOrigin } from "./lib/csrf";
import { withSecurityHeaders } from "./lib/security-headers";
import { app as apiApp, receiveEmail } from "./index";
import { EmailMCP } from "./mcp";
import type { Env } from "./types";

export { MailboxDO } from "./durableObject";
export { MailIndexDO } from "./durableObject/mail-index";
export { EmailAgent } from "./agent";
export { EmailMCP } from "./mcp";

declare module "react-router" {
	export interface AppLoadContext {
		cloudflare: {
			env: Env;
			ctx: ExecutionContext;
		};
	}
}

const requestHandler = createRequestHandler(
	() => import("virtual:react-router/server-build"),
	import.meta.env.MODE,
);

// Main app that wraps the API and adds React Router fallback
const app = new Hono<{ Bindings: Env }>();
app.use("*", async (c, next) => {
	await next();
	c.res = withSecurityHeaders(c.res);
});

// Cloudflare Access JWT validation middleware (production only)
app.use("*", async (c, next) => {
	// Skip validation in development
	if (import.meta.env.DEV) {
		return next();
	}

	const { POLICY_AUD, TEAM_DOMAIN } = c.env;

	// Fail closed in production if Access is not configured, or still has the deploy button's placeholders.
	const configError = accessConfigError({ POLICY_AUD, TEAM_DOMAIN });
	if (configError) {
		return errorResponse(c.req.raw, 500, "Access is not set up",
			configError);
	}

	const token = c.req.header("cf-access-jwt-assertion");
	if (!token) {
		return errorResponse(c.req.raw, 403, "Not signed in", "Missing required CF Access JWT");
	}

	try {
		const { issuer, certsUrl } = getAccessUrls(TEAM_DOMAIN);
		await jwtVerify(token, accessJwks(certsUrl), {
			issuer,
			audience: POLICY_AUD,
			algorithms: ["RS256"],
		});
	} catch {
		return errorResponse(c.req.raw, 403, "Sign in again", "Invalid or expired Access token");
	}

	// Authorization model note: once a teammate passes the shared Cloudflare
	// Access policy, they can access all mailboxes in this app by design.
	return next();
});

// MCP server endpoint — used by AI coding tools (ProtoAgent, Claude Code, Cursor, etc.)
// Must be before API routes and React Router catch-all
const mcpHandler = EmailMCP.serve("/mcp", { binding: "EMAIL_MCP" });
app.all("/mcp", async (c) => {
	if (foreignOrigin(c.req.raw)) return c.text("Cross-origin request refused", 403);
	return mcpHandler.fetch(c.req.raw, c.env, c.executionCtx as ExecutionContext);
});
app.all("/mcp/*", async (c) => {
	if (foreignOrigin(c.req.raw)) return c.text("Cross-origin request refused", 403);
	return mcpHandler.fetch(c.req.raw, c.env, c.executionCtx as ExecutionContext);
});

// Mount the API routes
app.route("/", apiApp);

// Agent WebSocket routing - must be before React Router catch-all
app.all("/agents/*", async (c) => {
	if (foreignOrigin(c.req.raw)) return c.text("Cross-origin request refused", 403);
	const response = await routeAgentRequest(c.req.raw, c.env);
	if (response) return response;
	return c.text("Agent not found", 404);
});

// React Router catch-all: serves the SPA for all non-API routes
app.all("*", (c) => {
	return requestHandler(c.req.raw, {
		cloudflare: { env: c.env, ctx: c.executionCtx as ExecutionContext },
	});
});

// Export the Hono app as the default export with an email handler
export default {
	fetch: app.fetch,
	async email(
		event: { to: string; raw: ReadableStream; rawSize: number },
		env: Env,
		ctx: ExecutionContext,
	) {
		try {
			await receiveEmail(event, env, ctx);
		} catch (e) {
			console.error("Failed to process incoming email:", (e as Error).message, (e as Error).stack);
			// Re-throw so Cloudflare's email routing can retry delivery or bounce the message.
			// Swallowing the error would silently drop the email.
			throw e;
		}
	},
	async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
		ctx.waitUntil(runCron(env).catch((e) => console.error("cron failed:", (e as Error).message)));
	},
};
