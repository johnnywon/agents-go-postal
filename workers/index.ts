// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import PostalMime from "postal-mime";
import { z } from "zod";
import { sendEmail } from "./email-sender";
import { storeAttachments, type StoredAttachment } from "./lib/attachments";
import {
	validateSender,
	SenderValidationError,
	generateMessageId,
	buildThreadingHeaders,
	listMailboxes,
} from "./lib/email-helpers";
import { SendEmailRequestSchema } from "./lib/schemas";
import { handleReplyEmail, handleForwardEmail } from "./routes/reply-forward";
import { Folders } from "../shared/folders";
import type { Env } from "./types";
import { requireMailbox, type MailboxContext } from "./lib/mailbox";
import { getCombinedInbox, InvalidInboxCursorError } from "./lib/combined-inbox";
import { csrf } from "./lib/csrf";
import { decodeCursor, InvalidFilterError } from "./lib/mail-index-sql";
import { parseMailParams } from "./lib/mail-filter-params";
import { getMailboxStub } from "./lib/email-helpers";
import { getMailIndexStub, indexedMailboxIds } from "./lib/mail-index-stub";
import { MOVE_FOLDERS } from "./lib/mail-bulk-sql";
import { dryRunFolderImport, importDeps, runFolderImport } from "./lib/folder-import";

type AppContext = Context<MailboxContext>;

// -- Request body schemas (kept for validation) ---------------------

const CreateMailboxBody = z.object({
	email: z.string().email(),
	name: z.string().min(1),
	settings: z.record(z.any()).optional(), // unvalidated — agentSystemPrompt goes straight to AI
});

const DraftBody = z.object({
	to: z.string().optional(),
	cc: z.string().optional(),
	bcc: z.string().optional(),
	subject: z.string().optional(),
	body: z.string(),
	in_reply_to: z.string().optional(),
	thread_id: z.string().optional(),
	draft_id: z.string().optional(),
});

const BulkBody = z.object({
	target: z.union([
		z.object({ threadKeys: z.array(z.string().min(1).max(600)).min(1).max(500), view: z.string().max(100) }),
		z.object({ filter: z.string().max(8000), asOf: z.string().datetime(), expectedCount: z.number().int().min(0) }),
	]),
	action: z.discriminatedUnion("type", [
		z.object({ type: z.enum(["archive", "trash", "restore", "read", "unread", "star", "unstar"]) }),
		z.object({ type: z.literal("move"), folder: z.enum(MOVE_FOLDERS) }),
		z.object({ type: z.enum(["label_add", "label_remove"]), labelId: z.string().min(1).max(100) }),
	]),
});

const LabelBody = z.object({ name: z.string().max(200).optional(), color: z.string().max(20).optional() });

// -- Helpers --------------------------------------------------------

function slugify(text: string) { // can return "" for non-alphanumeric input
	return text.toString().toLowerCase()
		.replace(/\s+/g, "-").replace(/[^\w-]+/g, "")
		.replace(/--+/g, "-").replace(/^-+/, "").replace(/-+$/, "");
}

function intQuery(c: AppContext, key: string): number | undefined {
	const v = c.req.query(key);
	if (!v) return undefined;
	const n = Number(v);
	return Number.isNaN(n) ? undefined : n;
}

function boolQuery(c: AppContext, key: string): boolean | undefined {
	const v = c.req.query(key);
	if (v === undefined || v === "") return undefined;
	return v === "true" || v === "1";
}

// -- App & middleware -----------------------------------------------

const app = new Hono<MailboxContext>();
app.use("/api/*", cors({
	origin: (origin) => {
		// Same-origin requests have no Origin header — allow them.
		if (!origin) return origin;
		// In development, allow localhost for Vite dev server.
		try {
			const url = new URL(origin);
			if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return origin;
		} catch { /* invalid origin */ }
		// Block all other cross-origin requests. The app is served from the
		// same origin as the API, so legitimate browser requests never send
		// an Origin header. Returning undefined omits Access-Control-Allow-Origin.
		return undefined;
	},
}));
app.use("/api/v1/*", csrf);
app.use("/api/v1/mailboxes/:mailboxId/*", requireMailbox);

// -- Config ---------------------------------------------------------

app.get("/api/v1/config", (c) => {
	const domainsRaw = c.env.DOMAINS || "";
	const domains = domainsRaw.split(",").map((d) => d.trim()).filter(Boolean);
	const emailAddresses = c.env.EMAIL_ADDRESSES ?? [];
	const mailUi = String(c.env.MAIL_UI ?? "") === "unified" ? "unified" : "classic";
	return c.json({ domains, emailAddresses, mailUi });
});

// Local QA only: fill each configured mailbox with sample inbox mail.
// import.meta.env.DEV is false in production builds, so this route does not exist there.
if (import.meta.env?.DEV) {
	app.post("/api/v1/dev/seed", async (c) => {
		const { perMailbox = 20 } = (await c.req.json().catch(() => ({}))) as { perMailbox?: number };
		const senders = ["ann@stripe.com", "billing@github.com", "news@substack.com", "ops@cloudflare.com", "maria@golf.club", "noreply@linear.app"];
		const subjects = ["Invoice for October", "Your weekly digest", "Tee time confirmed", "Deploy finished", "Re: contract draft", "Security alert"];
		const ids = await indexedMailboxIds(c.env);
		let created = 0;
		for (const [m, mailboxId] of ids.entries()) {
			const stub = getMailboxStub(c.env, mailboxId);
			await stub.setMailboxId(mailboxId);
			for (let i = 0; i < Math.min(perMailbox, 100); i++) {
				const id = crypto.randomUUID();
				const sender = senders[(i + m) % senders.length];
				await stub.createEmail(Folders.INBOX, {
					id, subject: `${subjects[(i * 7 + m) % subjects.length]} #${i}`, sender, recipient: mailboxId,
					date: new Date(Date.now() - (i * 9 + m) * 3_600_000).toISOString(),
					body: `<p>Sample message ${i} for ${mailboxId}. Quarterly numbers and a follow-up.</p>`,
					read: i % 3 === 0, starred: i % 11 === 0, thread_id: id, message_id: `${id}@seed.local`,
					raw_headers: JSON.stringify([{ key: "from", value: `"${sender.split("@")[0]}" <${sender}>` },
						...(sender.startsWith("news") ? [{ key: "list-unsubscribe", value: "<https://substack.com/u>" }] : [])]),
				}, []);
				created++;
			}
		}
		return c.json({ created });
	});
}

// -- Mailboxes ------------------------------------------------------

app.get("/api/v1/mailboxes", async (c) => {
	const allMailboxes = await listMailboxes(c.env.BUCKET);
	return c.json(allMailboxes.map((m) => ({ ...m, name: m.id })));
});

app.post("/api/v1/mailboxes", async (c) => {
	const { name, settings, email: rawEmail } = CreateMailboxBody.parse(await c.req.json());
	const email = rawEmail.toLowerCase();
	const allowedAddresses = (c.env.EMAIL_ADDRESSES ?? []) as string[];
	if (allowedAddresses.length > 0 && !allowedAddresses.map((a) => a.toLowerCase()).includes(email)) {
		return c.json({ error: "Mailbox creation is restricted to configured EMAIL_ADDRESSES" }, 403);
	}
	if (await c.env.BUCKET.head(`mailboxes/${email}.json`)) return c.json({ error: "Mailbox already exists" }, 409);
	const finalSettings = await createMailbox(c.env, email, name, settings);
	return c.json({ id: email, email, name, settings: finalSettings }, 201);
});

/** Store a mailbox's settings and tell its Durable Object its address. */
async function createMailbox(env: Env, email: string, name: string, settings?: Record<string, unknown>) {
	const defaultSettings = { fromName: name, forwarding: { enabled: false, email: "" }, signature: { enabled: false, text: "" }, autoReply: { enabled: false, subject: "", message: "" } };
	const finalSettings = { ...defaultSettings, ...settings };
	await env.BUCKET.put(`mailboxes/${email}.json`, JSON.stringify(finalSettings));
	await env.MAILBOX.get(env.MAILBOX.idFromName(email)).setMailboxId(email);
	return finalSettings;
}

app.get("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	const obj = await c.env.BUCKET.get(`mailboxes/${mailboxId}.json`);
	if (!obj) return c.json({ error: "Not found" }, 404);
	return c.json({ id: mailboxId, name: mailboxId, email: mailboxId, settings: await obj.json() });
});

app.put("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	const { settings } = (await c.req.json()) as { settings: Record<string, unknown> };
	const key = `mailboxes/${mailboxId}.json`;
	if (!(await c.env.BUCKET.head(key))) return c.json({ error: "Not found" }, 404);
	await c.env.BUCKET.put(key, JSON.stringify(settings));
	return c.json({ id: mailboxId, name: mailboxId, email: mailboxId, settings });
});

app.delete("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	const key = `mailboxes/${mailboxId}.json`;
	if (!(await c.env.BUCKET.head(key))) return c.json({ error: "Not found" }, 404);
	await c.env.BUCKET.delete(key); // TODO: also delete DO data and R2 attachment blobs
	await getMailIndexStub(c.env).purgeMailbox(mailboxId);
	return c.body(null, 204);
});

// -- Unified mail (MailIndexDO) -------------------------------------

function parseMailRequest(url: string) {
	const parsed = parseMailParams(new URL(url).searchParams);
	if (parsed.cursor) decodeCursor(parsed.cursor);
	return parsed;
}

app.get("/api/v1/mail", async (c) => {
	try {
		const { filter, cursor, limit } = parseMailRequest(c.req.url);
		return c.json(await getMailIndexStub(c.env).queryMail(filter, { cursor, limit }));
	} catch (error) {
		if (error instanceof InvalidFilterError) return c.json({ error: error.message }, 400);
		throw error;
	}
});

app.get("/api/v1/mail/facets", async (c) => {
	try {
		const { filter } = parseMailRequest(c.req.url);
		return c.json(await getMailIndexStub(c.env).queryFacets(filter));
	} catch (error) {
		if (error instanceof InvalidFilterError) return c.json({ error: error.message }, 400);
		throw error;
	}
});

app.get("/api/v1/mail/folders", async (c) => c.json(await getMailIndexStub(c.env).folderViews()));

/** Index parity: the index's counts beside each mailbox's own counts. */
app.get("/api/v1/index/status", async (c) => {
	const index = getMailIndexStub(c.env);
	const [status, mailboxIds] = await Promise.all([index.status(), indexedMailboxIds(c.env)]);
	const mailboxes = await Promise.all(mailboxIds.map(async (mailboxId) => {
		try {
			return { mailboxId, source: await getMailboxStub(c.env, mailboxId).indexStatus(), index: status.counts[mailboxId] ?? null };
		} catch (e) {
			return { mailboxId, error: (e as Error).message, index: status.counts[mailboxId] ?? null };
		}
	}));
	return c.json({ messages: status.messages, job: status.job, probe: status.probe, mailboxes });
});

app.post("/api/v1/index/rebuild", async (c) => {
	return c.json(await getMailIndexStub(c.env).startRebuild(), 202);
});

// -- Bulk actions ---------------------------------------------------

app.post("/api/v1/mail/bulk", async (c) => {
	const parsed = BulkBody.safeParse(await c.req.json().catch(() => null));
	if (!parsed.success) return c.json({ error: "Invalid bulk request" }, 400);
	const { target, action } = parsed.data;
	try {
		const resolved = "threadKeys" in target
			? { threadKeys: target.threadKeys, view: parseMailParams(new URLSearchParams({ view: target.view })).filter.view }
			: { filter: parseMailParams(new URLSearchParams(target.filter)).filter, asOf: target.asOf, expectedCount: target.expectedCount };
		const result = await getMailIndexStub(c.env).bulk(resolved, action);
		if ("conflict" in result) return c.json({ error: "The list changed. Check the selection and try again.", count: result.conflict }, 409);
		if ("job" in result) return c.json(result.job, 202);
		return c.json(result);
	} catch (error) {
		if (error instanceof InvalidFilterError) return c.json({ error: error.message }, 400);
		throw error;
	}
});

app.post("/api/v1/mail/bulk/undo", async (c) => {
	const { undoId } = (await c.req.json().catch(() => ({}))) as { undoId?: unknown };
	if (typeof undoId !== "string" || !undoId) return c.json({ error: "undoId is required" }, 400);
	const result = await getMailIndexStub(c.env).undo(undoId);
	return result ? c.json(result) : c.json({ error: "Nothing to undo. Undo lasts one hour." }, 404);
});

app.get("/api/v1/mail/bulk/jobs/:id", async (c) => {
	const job = await getMailIndexStub(c.env).bulkJob(c.req.param("id"));
	return job ? c.json(job) : c.json({ error: "Not found" }, 404);
});

app.get("/api/v1/mail/trash", async (c) => c.json(await getMailIndexStub(c.env).trashCount()));

/** Permanently delete everything in Trash. No undo; the count must match what the user confirmed. */
app.post("/api/v1/mail/empty-trash", async (c) => {
	const { expectedCount } = (await c.req.json().catch(() => ({}))) as { expectedCount?: unknown };
	if (typeof expectedCount !== "number" || !Number.isInteger(expectedCount) || expectedCount < 0) {
		return c.json({ error: "expectedCount is required" }, 400);
	}
	const result = await getMailIndexStub(c.env).emptyTrash(expectedCount);
	if ("conflict" in result) return c.json({ error: "Trash changed. Check the count and try again.", count: result.conflict }, 409);
	if ("job" in result) return c.json(result.job, 202);
	return c.json(result);
});

// -- Labels ---------------------------------------------------------

app.get("/api/v1/labels", async (c) => c.json(await getMailIndexStub(c.env).listLabels()));

app.post("/api/v1/labels", async (c) => {
	const parsed = LabelBody.safeParse(await c.req.json().catch(() => null));
	if (!parsed.success) return c.json({ error: "Invalid label" }, 400);
	const result = await getMailIndexStub(c.env).createLabel({ name: parsed.data.name, color: parsed.data.color });
	return result.label ? c.json(result.label, 201) : c.json({ error: result.error }, 400);
});

app.put("/api/v1/labels/:id", async (c) => {
	const parsed = LabelBody.safeParse(await c.req.json().catch(() => null));
	if (!parsed.success) return c.json({ error: "Invalid label" }, 400);
	const result = await getMailIndexStub(c.env).updateLabel(c.req.param("id"), parsed.data);
	if (result.error) return c.json({ error: result.error }, 400);
	return result.label ? c.json(result.label) : c.json({ error: "Not found" }, 404);
});

app.delete("/api/v1/labels/:id", async (c) => {
	const result = await getMailIndexStub(c.env).deleteLabel(c.req.param("id"));
	if (!result) return c.json({ error: "Not found" }, 404);
	if (!result.deleted) return c.json({ error: "Some mailboxes could not drop the label. Try again.", failed: result.failed }, 502);
	return c.json(result);
});

/** Folder to label conversion. `dryRun` reports counts; a real run needs `confirm: true`. */
app.post("/api/v1/labels/import-folders", async (c) => {
	const { dryRun = true, confirm = false } = (await c.req.json().catch(() => ({}))) as { dryRun?: boolean; confirm?: boolean };
	const deps = importDeps(c.env);
	if (dryRun !== false) return c.json(await dryRunFolderImport(deps));
	if (confirm !== true) return c.json({ error: "Send confirm: true to convert folders" }, 400);
	return c.json(await runFolderImport(deps));
});

// -- Emails ---------------------------------------------------------

app.get("/api/v1/inbox", async (c) => {
	try {
		return c.json(await getCombinedInbox(c.env, c.req.query("cursor")));
	} catch (error) {
		if (error instanceof InvalidInboxCursorError) return c.json({ error: error.message }, 400);
		throw error;
	}
});

app.get("/api/v1/mailboxes/:mailboxId/emails", async (c: AppContext) => {
	const folder = c.req.query("folder");
	const thread_id = c.req.query("thread_id");
	const threaded = boolQuery(c, "threaded");
	const page = intQuery(c, "page");
	const limit = intQuery(c, "limit");
	const sortColumn = c.req.query("sortColumn") as any;
	const sortDirection = c.req.query("sortDirection") as "ASC" | "DESC" | undefined;
	const stub = c.var.mailboxStub;

	if (threaded && folder) {
		const emails = await (stub as any).getThreadedEmails({ folder, page, limit });
		const totalCount = await (stub as any).countThreadedEmails(folder);
		return c.json({ emails, totalCount });
	}
	const emails = await stub.getEmails({ folder, thread_id, page, limit, sortColumn, sortDirection });
	if (folder) {
		const totalCount = await stub.countEmails({ folder, thread_id });
		return c.json({ emails, totalCount });
	}
	return c.json(emails);
});

app.post("/api/v1/mailboxes/:mailboxId/emails", async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!;
	const body = SendEmailRequestSchema.parse(await c.req.json());
	const { to, cc, bcc, from, subject, html, text, attachments, in_reply_to, references, thread_id } = body;

	let toStr: string, fromEmail: string, fromDomain: string;
	try {
		({ toStr, fromEmail, fromDomain } = validateSender(to, from, mailboxId));
	} catch (e) {
		if (e instanceof SenderValidationError) return c.json({ error: e.message }, 400);
		throw e;
	}

	const { messageId, outgoingMessageId } = generateMessageId(fromDomain);
	const stub = c.var.mailboxStub;
	const rateLimitError = await (stub as any).checkSendRateLimit();
	if (rateLimitError) return c.json({ error: rateLimitError }, 429);
	const attachmentData = await storeAttachments(c.env.BUCKET, messageId, attachments);

	await stub.createEmail(Folders.SENT, {
		id: messageId, subject, sender: fromEmail, recipient: toStr,
		cc: cc ? (Array.isArray(cc) ? cc.join(", ") : cc).toLowerCase() : null,
		bcc: bcc ? (Array.isArray(bcc) ? bcc.join(", ") : bcc).toLowerCase() : null,
		date: new Date().toISOString(), body: html || text || "",
		in_reply_to: in_reply_to || null, email_references: references ? JSON.stringify(references) : null,
		thread_id: thread_id || in_reply_to || messageId, message_id: outgoingMessageId,
		raw_headers: JSON.stringify([
			{ key: "from", value: typeof from === "string" ? from : `${from.name} <${from.email}>` },
			{ key: "to", value: Array.isArray(to) ? to.join(", ") : to },
			...(cc ? [{ key: "cc", value: Array.isArray(cc) ? cc.join(", ") : cc }] : []),
			...(bcc ? [{ key: "bcc", value: Array.isArray(bcc) ? bcc.join(", ") : bcc }] : []),
			{ key: "subject", value: subject }, { key: "date", value: new Date().toISOString() },
			{ key: "message-id", value: `<${outgoingMessageId}>` },
		]),
	}, attachmentData);

	c.executionCtx.waitUntil(
		sendEmail(c.env.EMAIL, {
			to, cc, bcc, from, subject, html, text,
			attachments: attachments?.map((att) => ({ content: att.content, filename: att.filename, type: att.type, disposition: att.disposition || "attachment", contentId: att.contentId })),
			...(in_reply_to ? { headers: buildThreadingHeaders(in_reply_to, references || []) } : {}),
		}).catch((e) => console.error("Deferred email delivery failed:", (e as Error).message)),
	);
	return c.json({ id: messageId, status: "sent" }, 202);
});

app.post("/api/v1/mailboxes/:mailboxId/drafts", async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!;
	const { to, cc, bcc, subject, body, in_reply_to, thread_id, draft_id } = DraftBody.parse(await c.req.json());
	const stub = c.var.mailboxStub;
	if (draft_id) await stub.deleteEmail(draft_id); // drafts only; not atomic — create-then-delete would be safer
	const messageId = crypto.randomUUID();
	const now = new Date().toISOString();
	await stub.createEmail(Folders.DRAFT, {
		id: messageId, subject: subject || "", sender: mailboxId.toLowerCase(),
		recipient: (to || "").toLowerCase(), cc: cc?.toLowerCase() || null, bcc: bcc?.toLowerCase() || null,
		date: now, body, in_reply_to: in_reply_to || null, email_references: null,
		thread_id: thread_id || in_reply_to || messageId,
	}, []);
	return c.json({ id: messageId, status: "draft", subject: subject || "", recipient: to || "", date: now }, 201);
});

app.get("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const email = await c.var.mailboxStub.getEmail(c.req.param("id")!);
	if (!email) return c.json({ error: "Email not found" }, 404);
	return new Response(JSON.stringify(email), {
		headers: { "Content-Type": "application/json" },
	});
});

app.put("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const { read, starred } = (await c.req.json()) as { read?: boolean; starred?: boolean };
	const email = await c.var.mailboxStub.updateEmail(c.req.param("id")!, { read, starred });
	return email ? c.json(email) : c.json({ error: "Email not found" }, 404);
});

// Delete moves mail to Trash. Only mail already in Trash, and drafts, are deleted permanently.
app.delete("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const id = c.req.param("id")!;
	const result = await c.var.mailboxStub.trashOrDelete(id);
	if (result === null) return c.json({ error: "Not found" }, 404);
	if (result.attachments.length > 0) await c.env.BUCKET.delete(result.attachments.map((att) => `attachments/${id}/${att.id}/${att.filename}`));
	return c.json({ status: result.action });
});

app.post("/api/v1/mailboxes/:mailboxId/emails/:id/move", async (c: AppContext) => {
	const { folderId } = (await c.req.json()) as { folderId: string };
	const success = await c.var.mailboxStub.moveEmail(c.req.param("id")!, folderId);
	return success ? c.json({ status: "moved" }) : c.json({ error: "Folder not found" }, 400);
});

// -- Threads --------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/threads/:threadId", async (c: AppContext) => {
	return c.json(await (c.var.mailboxStub as any).getThreadEmails(c.req.param("threadId")!));
});

app.post("/api/v1/mailboxes/:mailboxId/threads/:threadId/read", async (c: AppContext) => {
	await c.var.mailboxStub.markThreadRead(c.req.param("threadId")!);
	return c.json({ status: "marked_read" });
});

// -- Reply / Forward ------------------------------------------------

app.post("/api/v1/mailboxes/:mailboxId/emails/:id/reply", handleReplyEmail);
app.post("/api/v1/mailboxes/:mailboxId/emails/:id/forward", handleForwardEmail);

// -- Folders --------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/folders", async (c: AppContext) => c.json(await c.var.mailboxStub.getFolders()));

app.post("/api/v1/mailboxes/:mailboxId/folders", async (c: AppContext) => {
	const { name } = (await c.req.json()) as { name: string };
	const slug = slugify(name);
	if (!slug) return c.json({ error: "Folder name must contain alphanumeric characters" }, 400);
	const f = await c.var.mailboxStub.createFolder(slug, name);
	return f ? c.json(f, 201) : c.json({ error: "Folder with this name already exists" }, 409);
});

app.put("/api/v1/mailboxes/:mailboxId/folders/:id", async (c: AppContext) => {
	const { name } = (await c.req.json()) as { name: string };
	const f = await c.var.mailboxStub.updateFolder(c.req.param("id")!, name);
	return f ? c.json(f) : c.json({ error: "Folder not found" }, 404);
});

app.delete("/api/v1/mailboxes/:mailboxId/folders/:id", async (c: AppContext) => {
	const result = await c.var.mailboxStub.deleteFolder(c.req.param("id")!);
	if (result === "deleted") return c.body(null, 204);
	if (result === "not_empty") return c.json({ error: "Folder still holds mail. Move it out first." }, 409);
	return c.json({ error: "Folder not found or cannot be deleted" }, 400);
});

// -- Search ---------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/search", async (c: AppContext) => {
	const searchOpts: Record<string, unknown> = {
		query: c.req.query("query") || "", folder: c.req.query("folder"), from: c.req.query("from"),
		to: c.req.query("to"), subject: c.req.query("subject"), date_start: c.req.query("date_start"),
		date_end: c.req.query("date_end"), is_read: boolQuery(c, "is_read"),
		is_starred: boolQuery(c, "is_starred"), has_attachment: boolQuery(c, "has_attachment"),
	};
	const stub = c.var.mailboxStub as any;
	const emails = await stub.searchEmails({ ...searchOpts, page: intQuery(c, "page"), limit: intQuery(c, "limit") });
	const totalCount = await stub.countSearchResults(searchOpts);
	return c.json({ emails, totalCount });
});

// -- Attachments ----------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/emails/:emailId/attachments/:attachmentId", async (c: AppContext) => {
	const emailId = c.req.param("emailId")!;
	const attachmentId = c.req.param("attachmentId")!;
	const attachment = await c.var.mailboxStub.getAttachment(attachmentId);
	if (!attachment) return c.json({ error: "Attachment not found" }, 404);
	const obj = await c.env.BUCKET.get(`attachments/${emailId}/${attachmentId}/${attachment.filename}`);
	if (!obj) return c.json({ error: "Attachment file not found" }, 404);
	const headers = new Headers();
	headers.set("Content-Type", attachment.mimetype);
	const sanitized = attachment.filename.replace(/[\x00-\x1f"\\]/g, "_");
	headers.set("Content-Disposition", `attachment; filename="${sanitized}"; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`);
	return new Response(obj.body, { headers });
});

// -- Receive inbound email ------------------------------------------

const MAX_EMAIL_SIZE = 25 * 1024 * 1024;

async function streamToArrayBuffer(stream: ReadableStream, streamSize: number) {
	if (streamSize > MAX_EMAIL_SIZE) throw new Error(`Email too large: ${streamSize} bytes exceeds ${MAX_EMAIL_SIZE} byte limit`);
	if (streamSize <= 0) throw new Error(`Invalid stream size: ${streamSize}`);
	const result = new Uint8Array(streamSize);
	let bytesRead = 0;
	const reader = stream.getReader();
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (bytesRead + value.length > streamSize) { reader.cancel(); throw new Error(`Stream exceeds declared size`); }
		result.set(value, bytesRead);
		bytesRead += value.length;
	}
	return result;
}

async function receiveEmail(event: { to: string; raw: ReadableStream; rawSize: number }, env: Env, ctx: ExecutionContext) {
	const rawEmail = await streamToArrayBuffer(event.raw, event.rawSize);
	const parsedEmail = await new PostalMime().parse(rawEmail);

	const allowedAddresses = ((env.EMAIL_ADDRESSES ?? []) as string[]).map((a) => a.toLowerCase());
	const allRecipients = (parsedEmail.to || []).map((t) => t.address?.toLowerCase()).filter(Boolean) as string[];
	const ccRecipients = (parsedEmail.cc || []).map((e) => e.address?.toLowerCase()).filter(Boolean) as string[];
	const bccRecipients = (parsedEmail.bcc || []).map((e) => e.address?.toLowerCase()).filter(Boolean) as string[];

	const mailboxId = event.to?.toLowerCase();
	if (!mailboxId) throw new Error("received email with no envelope recipient");
	if (allowedAddresses.length > 0 && !allowedAddresses.includes(mailboxId)) {
		console.log(`Ignoring email: envelope recipient does not match EMAIL_ADDRESSES.`);
		return;
	}

	const messageId = crypto.randomUUID();
	if (!(await env.BUCKET.head(`mailboxes/${mailboxId}.json`))) {
		// A configured address gets its mailbox on first delivery, so mail sent before anyone opens the app is kept.
		if (allowedAddresses.length === 0) { console.log(`Ignoring email for ${mailboxId}: mailbox does not exist`); return; }
		await createMailbox(env, mailboxId, mailboxId.split("@")[0] || mailboxId);
	}

	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));

	const attachmentData: StoredAttachment[] = [];
	if (parsedEmail.attachments) {
		for (const att of parsedEmail.attachments) {
			const attId = crypto.randomUUID();
			const filename = (att.filename || "untitled").replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_");
			await env.BUCKET.put(`attachments/${messageId}/${attId}/${filename}`, att.content);
			attachmentData.push({ id: attId, email_id: messageId, filename, mimetype: att.mimeType,
				size: typeof att.content === "string" ? att.content.length : att.content.byteLength,
				content_id: att.contentId || null, disposition: att.disposition || "attachment" });
		}
	}

	const extractMsgId = (s: string) => { const m = s.match(/<([^>]+)>/); return m ? m[1] : s.trim().split(/\s+/)[0]; };
	const inReplyTo = parsedEmail.inReplyTo ? extractMsgId(parsedEmail.inReplyTo) : null;
	const emailReferences = parsedEmail.references ? parsedEmail.references.split(/\s+/).filter(Boolean).map(extractMsgId) : [];
	let threadId = emailReferences[0] || inReplyTo || messageId;

	if (!inReplyTo && emailReferences.length === 0) {
		const subjectThread = await (stub as any).findThreadBySubject(parsedEmail.subject || "", parsedEmail.from?.address || undefined);
		if (subjectThread) threadId = subjectThread;
	}

	const originalMessageId = parsedEmail.messageId ? extractMsgId(parsedEmail.messageId) : null;

	await stub.createEmail(Folders.INBOX, {
		id: messageId, subject: parsedEmail.subject || "",
		sender: (parsedEmail.from?.address || "").toLowerCase(), recipient: allRecipients.join(", ") || mailboxId,
		cc: ccRecipients.join(", ") || null, bcc: bccRecipients.join(", ") || null,
		date: new Date().toISOString(), // uses receive time, not the email's Date header
		body: parsedEmail.html || parsedEmail.text || "",
		in_reply_to: inReplyTo, email_references: emailReferences.length > 0 ? JSON.stringify(emailReferences) : null,
		thread_id: threadId, message_id: originalMessageId, raw_headers: JSON.stringify(parsedEmail.headers),
	}, attachmentData);

	if (String(env.AUTO_DRAFT_ENABLED) === "true") {
		const agentStub = env.EMAIL_AGENT.get(env.EMAIL_AGENT.idFromName(mailboxId));
		ctx.waitUntil(agentStub.handleNewEmail({
			mailboxId,
			emailId: messageId,
			sender: (parsedEmail.from?.address || "").toLowerCase(),
			subject: parsedEmail.subject || "",
			threadId,
		}).catch((e) => console.error("Auto-draft trigger failed:", (e as Error).message)));
	}
}

export { app, receiveEmail };
