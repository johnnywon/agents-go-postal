// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { createMiddleware } from "hono/factory";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Refuse cross-site writes. Cloudflare Access cookies ride along on any
 * request to the origin, so a write must come from this app (Fetch Metadata
 * or Origin) and carry a JSON body type, which a plain HTML form cannot send.
 */
export const csrf = createMiddleware(async (c, next) => {
	if (SAFE_METHODS.has(c.req.method)) return next();
	const site = c.req.header("sec-fetch-site");
	const origin = c.req.header("origin");
	if (site !== "same-origin" && site !== "none" && origin !== new URL(c.req.url).origin) {
		return c.json({ error: "Cross-site request refused" }, 403);
	}
	const contentType = (c.req.header("content-type") ?? "").toLowerCase();
	if (!contentType.startsWith("application/json")) {
		return c.json({ error: "Content-Type must be application/json" }, 415);
	}
	return next();
});
