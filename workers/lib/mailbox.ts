// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Hono middleware: checks the mailbox exists in R2, then attaches its
 * store to the Hono context (`c.var.mailbox`).
 */
import { createMiddleware } from "hono/factory";
import { mailStore, type MailboxStore } from "../store";
import type { Env } from "../types";

export type MailboxContext = {
	Bindings: Env;
	Variables: {
		mailbox: MailboxStore;
	};
};

export const requireMailbox = createMiddleware<MailboxContext>(async (c, next) => {
	const rawId = c.req.param("mailboxId");
	if (!rawId) return c.json({ error: "Mailbox ID required" }, 400);
	const mailboxId = decodeURIComponent(rawId);

	// Verify mailbox exists
	const key = `mailboxes/${mailboxId}.json`;
	const obj = await c.env.BUCKET.head(key);
	if (!obj) {
		return c.json({ error: "Not found" }, 404);
	}

	c.set("mailbox", mailStore(c.env).mailbox(mailboxId));
	
	await next();
});
