// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Context } from "hono";
import { SendEmailRequestSchema } from "../lib/schemas";
import { sendMail, type SendMode } from "../lib/send";
import type { MailboxContext } from "../lib/mailbox";

type AppContext = Context<MailboxContext>;

async function handleSend(c: AppContext, kind: SendMode["kind"]) {
	const mailboxId = c.req.param("mailboxId") ?? "";
	const id = c.req.param("id") ?? "";
	const body = SendEmailRequestSchema.parse(await c.req.json());
	const mode: SendMode = kind === "new" ? { kind } : { kind, originalId: id };
	const result = await sendMail(c.env, mailboxId, c.var.mailboxStub, body, mode, {
		defer: (delivery) => c.executionCtx.waitUntil(delivery),
	});
	if (!result.ok) return c.json({ error: result.error }, result.status);
	return c.json({ id: result.id, status: "sent" }, 202);
}

export const handleSendEmail = (c: AppContext) => handleSend(c, "new");
export const handleReplyEmail = (c: AppContext) => handleSend(c, "reply");
export const handleForwardEmail = (c: AppContext) => handleSend(c, "forward");
