// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import PostalMime from "postal-mime";
import { z } from "zod";
import { generateText } from "ai";
import { type StoredAttachment } from "./lib/attachments";
import {
	validateSender,
	SenderValidationError,
} from "./lib/email-helpers";
import { checkSendAt, ScheduleBody, SCHEDULE_MAX_PAYLOAD_BYTES } from "./lib/scheduled-send";
import { handleReplyEmail, handleForwardEmail, handleSendEmail } from "./routes/reply-forward";
import { Folders } from "../shared/folders";
import type { Env } from "./types";
import { interpretSearch, MAX_REQUEST_LENGTH } from "./lib/search-interpret";
import { mergeAgentModelConfig, quickModel, OPENROUTER_BASE, openRouterModel, readAgentModelConfig, viewOf, writeAgentModelConfig } from "./lib/agent-model";
import { requireMailbox, type MailboxContext } from "./lib/mailbox";
import { csrf } from "./lib/csrf";
import { decodeCursor, InvalidFilterError } from "./lib/mail-index-sql";
import { parseMailParams } from "./lib/mail-filter-params";
import { MAX_SEARCH_LENGTH } from "../shared/search-query";
import { indexedMailboxIds } from "./lib/mail-index-stub";
import { d1Status, durableObjectInternals, hasD1, mailStore, searchEngine, usesD1 } from "./store";
import { advanceCopy, copyStartError, copyStatus, mirrorInbound, startCopy } from "./store/copy-job";
import { MOVE_FOLDERS } from "./lib/mail-bulk-sql";
import { automatedMailReason } from "./lib/message-meta";
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
	const autoDraft = String(c.env.AUTO_DRAFT_ENABLED ?? "") === "true";
	return c.json({ domains, emailAddresses, autoDraft });
});

// Local QA only: fill each configured mailbox with sample inbox mail.
// import.meta.env.DEV is false in production builds, so this route does not exist there.
if (import.meta.env?.DEV) {
	app.post("/api/v1/dev/seed", async (c) => {
		const { perMailbox = 20 } = (await c.req.json().catch(() => ({}))) as { perMailbox?: number };
		const senders = ["ann@store.example.com", "billing@code.example.com", "news@letters.example.net", "ops@cloud.example.org", "maria@golf.example.com", "noreply@tracker.example.net"];
		const subjects = ["Invoice for October", "Your weekly digest", "Tee time confirmed", "Deploy finished", "Re: contract draft", "Security alert"];
		const ids = await indexedMailboxIds(c.env);
		let created = 0;
		for (const [m, mailboxId] of ids.entries()) {
			if (!usesD1(c.env)) await durableObjectInternals(c.env).mailbox(mailboxId).setMailboxId(mailboxId);
			const stub = mailStore(c.env).mailbox(mailboxId);
			for (let i = 0; i < Math.min(perMailbox, 100); i++) {
				const id = crypto.randomUUID();
				const sender = senders[(i + m) % senders.length];
				await stub.createEmail(Folders.INBOX, {
					id, subject: `${subjects[(i * 7 + m) % subjects.length]} #${i}`, sender, recipient: mailboxId,
					date: new Date(Date.now() - (i * 9 + m) * 3_600_000).toISOString(),
					body: `<p>Sample message ${i} for ${mailboxId}. Quarterly numbers and a follow-up.</p>`,
					read: i % 3 === 0, starred: i % 11 === 0, thread_id: id, message_id: `${id}@seed.local`,
					raw_headers: JSON.stringify([{ key: "from", value: `"${sender.split("@")[0]}" <${sender}>` },
						...(sender.startsWith("news") ? [{ key: "list-unsubscribe", value: "<https://letters.example.net/u>" }] : [])]),
				}, []);
				created++;
			}
		}
		return c.json({ created });
	});
}

// -- Agent model ----------------------------------------------------

app.get("/api/v1/agent-model", async (c) => {
	return c.json(viewOf(await readAgentModelConfig(c.env)));
});

const AgentModelBody = z.object({
	provider: z.enum(["workers-ai", "openrouter"]).optional(),
	model: z.string().max(200).optional(),
	apiKey: z.string().max(500).optional(),
});

app.put("/api/v1/agent-model", async (c) => {
	const body = AgentModelBody.parse(await c.req.json());
	const next = mergeAgentModelConfig(await readAgentModelConfig(c.env), body);
	if ("error" in next) return c.json({ error: next.error }, 400);
	await writeAgentModelConfig(c.env, next);
	return c.json(viewOf(next));
});

/** Send one short prompt to OpenRouter with the given (or stored) key and model. */
app.post("/api/v1/agent-model/test", async (c) => {
	const body = AgentModelBody.parse(await c.req.json().catch(() => ({})));
	const stored = await readAgentModelConfig(c.env);
	const apiKey = body.apiKey?.trim() || stored.apiKey;
	const model = body.model?.trim() || stored.model;
	if (!apiKey || !model) return c.json({ ok: false, error: "Add an API key and a model first." }, 400);
	try {
		const result = await generateText({
			model: openRouterModel(apiKey, model),
			prompt: "Reply with the single word OK.",
			maxOutputTokens: 16,
		});
		return c.json({ ok: true, reply: result.text.trim().slice(0, 80) });
	} catch (e) {
		return c.json({ ok: false, error: (e as Error).message.slice(0, 300) }, 502);
	}
});

/** OpenRouter models that can call tools, for the model picker. */
app.get("/api/v1/agent-model/models", async (c) => {
	const res = await fetch(`${OPENROUTER_BASE}/models?supported_parameters=tools`);
	if (!res.ok) return c.json({ models: [] });
	const data = (await res.json()) as { data?: { id: string; name?: string }[] };
	const models = (data.data ?? []).map((m) => ({ id: m.id, name: m.name ?? m.id }));
	return c.json({ models });
});

// -- Mailboxes ------------------------------------------------------

app.get("/api/v1/mailboxes", async (c) => {
	const allMailboxes = await mailStore(c.env).mailboxes.list();
	return c.json(allMailboxes.map((m) => ({ ...m, name: m.id })));
});

app.post("/api/v1/mailboxes", async (c) => {
	const { name, settings, email: rawEmail } = CreateMailboxBody.parse(await c.req.json());
	const email = rawEmail.toLowerCase();
	const allowedAddresses = (c.env.EMAIL_ADDRESSES ?? []) as string[];
	if (allowedAddresses.length > 0 && !allowedAddresses.map((a) => a.toLowerCase()).includes(email)) {
		return c.json({ error: "Mailbox creation is restricted to configured EMAIL_ADDRESSES" }, 403);
	}
	if (await mailStore(c.env).mailboxes.exists(email)) return c.json({ error: "Mailbox already exists" }, 409);
	const finalSettings = await createMailbox(c.env, email, name, settings);
	return c.json({ id: email, email, name, settings: finalSettings }, 201);
});

/** Create a mailbox with default settings. */
async function createMailbox(env: Env, email: string, name: string, settings?: Record<string, unknown>) {
	const defaultSettings = { fromName: name, forwarding: { enabled: false, email: "" }, signature: { enabled: false, text: "" }, autoReply: { enabled: false, subject: "", message: "" } };
	const finalSettings = { ...defaultSettings, ...settings };
	await mailStore(env).mailboxes.put(email, finalSettings);
	return finalSettings;
}

app.get("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	const settings = await mailStore(c.env).mailboxes.get(mailboxId);
	if (!settings) return c.json({ error: "Not found" }, 404);
	return c.json({ id: mailboxId, name: mailboxId, email: mailboxId, settings });
});

app.put("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	const { settings } = (await c.req.json()) as { settings: Record<string, unknown> };
	const mailboxes = mailStore(c.env).mailboxes;
	if (!(await mailboxes.exists(mailboxId))) return c.json({ error: "Not found" }, 404);
	await mailboxes.put(mailboxId, settings);
	return c.json({ id: mailboxId, name: mailboxId, email: mailboxId, settings });
});

// -- Unified mail (MailIndexDO) -------------------------------------

function parseMailRequest(env: Env, url: string) {
	const parsed = parseMailParams(new URL(url).searchParams, searchEngine(env));
	if (parsed.cursor) decodeCursor(parsed.cursor);
	return parsed;
}

app.get("/api/v1/mail", async (c) => {
	try {
		const { filter, cursor, limit } = parseMailRequest(c.env, c.req.url);
		return c.json(await mailStore(c.env).all().queryMail(filter, { cursor, limit }));
	} catch (error) {
		if (error instanceof InvalidFilterError) return c.json({ error: error.message }, 400);
		throw error;
	}
});

app.get("/api/v1/mail/facets", async (c) => {
	try {
		const { filter } = parseMailRequest(c.env, c.req.url);
		return c.json(await mailStore(c.env).all().queryFacets(filter));
	} catch (error) {
		if (error instanceof InvalidFilterError) return c.json({ error: error.message }, 400);
		throw error;
	}
});

/** Scheduled sends across every configured mailbox, soonest first. */
app.get("/api/v1/mail/scheduled", async (c) => {
	const mailboxIds = await indexedMailboxIds(c.env);
	const lists = await Promise.all(mailboxIds.map(async (mailboxId) => {
		const rows = await mailStore(c.env).mailbox(mailboxId).listScheduled().catch((e) => {
			console.error(`scheduled list failed for ${mailboxId}:`, (e as Error).message);
			return [];
		});
		return rows.map((row) => ({ mailboxId, emailId: row.emailId, sendAt: row.sendAt, error: row.error }));
	}));
	return c.json(lists.flat().sort((a, b) => a.sendAt.localeCompare(b.sendAt)));
});

app.get("/api/v1/mail/folders", async (c) => c.json(await mailStore(c.env).all().folderViews()));

/** Index parity: the index's counts beside each mailbox's own counts. */
app.get("/api/v1/index/status", async (c) => {
	if (usesD1(c.env)) return c.json(await d1Status(c.env, await indexedMailboxIds(c.env)));
	const internals = durableObjectInternals(c.env);
	const index = internals.index();
	const [status, mailboxIds] = await Promise.all([index.status(), indexedMailboxIds(c.env)]);
	const mailboxes = await Promise.all(mailboxIds.map(async (mailboxId) => {
		try {
			return { mailboxId, source: await internals.mailbox(mailboxId).indexStatus(), index: status.counts[mailboxId] ?? null };
		} catch (e) {
			return { mailboxId, error: (e as Error).message, index: status.counts[mailboxId] ?? null };
		}
	}));
	return c.json({ messages: status.messages, job: status.job, probe: status.probe, mailboxes });
});

app.post("/api/v1/index/rebuild", async (c) => {
	if (usesD1(c.env)) return c.json({ error: "D1 keeps one copy of the mail, so there is no separate index to rebuild" }, 409);
	return c.json(await durableObjectInternals(c.env).index().startRebuild(), 202);
});

/** The one-time copy to D1: progress and the parity report. */
app.get("/api/v1/admin/migrate-to-d1", async (c) => {
	if (!hasD1(c.env)) return c.json({ available: false, storage: "durable-objects", state: "none", mailboxes: [], parity: null });
	return c.json({ available: true, storage: usesD1(c.env) ? "d1" : "durable-objects", ...(await copyStatus(c.env)) });
});

/** Start the copy. The cron carries it on; this runs its first slice. */
app.post("/api/v1/admin/migrate-to-d1", async (c) => {
	const { confirm } = (await c.req.json().catch(() => ({}))) as { confirm?: unknown };
	if (confirm !== true) return c.json({ error: "Send { confirm: true } to start the copy" }, 400);
	const error = await copyStartError(c.env);
	if (error) return c.json({ error }, 409);
	await startCopy(c.env);
	c.executionCtx.waitUntil(advanceCopy(c.env).catch((e) => console.error("copy to D1 failed:", (e as Error).message)));
	return c.json(await copyStatus(c.env), 202);
});

// -- Bulk actions ---------------------------------------------------

app.post("/api/v1/mail/bulk", async (c) => {
	const parsed = BulkBody.safeParse(await c.req.json().catch(() => null));
	if (!parsed.success) return c.json({ error: "Invalid bulk request" }, 400);
	const { target, action } = parsed.data;
	try {
		const resolved = "threadKeys" in target
			? { threadKeys: target.threadKeys, view: parseMailParams(new URLSearchParams({ view: target.view })).filter.view }
			: { filter: parseMailParams(new URLSearchParams(target.filter), searchEngine(c.env)).filter, asOf: target.asOf, expectedCount: target.expectedCount };
		const result = await mailStore(c.env).all().bulk(resolved, action);
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
	const result = await mailStore(c.env).all().undo(undoId);
	return result ? c.json(result) : c.json({ error: "Nothing to undo. Undo lasts one hour." }, 404);
});

app.get("/api/v1/mail/bulk/jobs/:id", async (c) => {
	const job = await mailStore(c.env).all().bulkJob(c.req.param("id"));
	return job ? c.json(job) : c.json({ error: "Not found" }, 404);
});

app.get("/api/v1/mail/trash", async (c) => c.json(await mailStore(c.env).all().trashCount()));

/** Permanently delete everything in Trash. No undo; the count must match what the user confirmed. */
app.post("/api/v1/mail/empty-trash", async (c) => {
	const { expectedCount } = (await c.req.json().catch(() => ({}))) as { expectedCount?: unknown };
	if (typeof expectedCount !== "number" || !Number.isInteger(expectedCount) || expectedCount < 0) {
		return c.json({ error: "expectedCount is required" }, 400);
	}
	const result = await mailStore(c.env).all().emptyTrash(expectedCount);
	if ("conflict" in result) return c.json({ error: "Trash changed. Check the count and try again.", count: result.conflict }, 409);
	if ("job" in result) return c.json(result.job, 202);
	return c.json(result);
});

// -- Search window --------------------------------------------------

/** Suggestions for the search window. The view and chips come as for /mail; `q` is the box and `at` the cursor. */
app.get("/api/v1/search/suggest", async (c) => {
	const url = new URL(c.req.url);
	const text = (url.searchParams.get("q") ?? "").slice(0, MAX_SEARCH_LENGTH);
	url.searchParams.delete("q");
	const at = Number(url.searchParams.get("at") ?? -1);
	try {
		const { filter } = parseMailRequest(c.env, url.toString());
		return c.json(await mailStore(c.env).all().suggest(filter, text, Number.isInteger(at) ? at : -1));
	} catch (error) {
		if (error instanceof InvalidFilterError) return c.json({ error: error.message }, 400);
		throw error;
	}
});

/**
 * "Ask in plain words": one model call turns the request into search text.
 * The text comes back for the box; nothing runs here. A failure returns the
 * request itself as the query, for a word search.
 */
app.post("/api/v1/search/interpret", async (c) => {
	const body = z.object({ text: z.string().max(MAX_REQUEST_LENGTH * 2), tz: z.number().int().min(-900).max(900).optional() })
		.safeParse(await c.req.json().catch(() => null));
	if (!body.success) return c.json({ error: "Invalid request" }, 400);
	const [labels, addresses, model] = await Promise.all([mailStore(c.env).all().listLabels(), indexedMailboxIds(c.env), quickModel(c.env)]);
	const result = await interpretSearch(
		body.data.text,
		{ now: new Date(), engine: searchEngine(c.env), tzOffset: body.data.tz ?? 0, labels: labels.map((l) => l.name), addresses },
		async (prompt) => (await generateText({ model, prompt, maxOutputTokens: 1500, temperature: 0 })).text,
	);
	return c.json(result, "error" in result ? 502 : 200);
});

const SavedSearchBody = z.object({
	name: z.string().max(200).optional(),
	query: z.string().max(MAX_SEARCH_LENGTH * 2).optional(),
	position: z.number().int().min(0).max(10_000).optional(),
});

/** Saved searches in order. `counts=1` adds how many conversations each matches in All mail. */
app.get("/api/v1/saved-searches", async (c) => {
	const counts = c.req.query("counts") === "1" ? { tzOffset: Number(c.req.query("tz") ?? 0) || 0 } : undefined;
	return c.json(await mailStore(c.env).all().listSavedSearches(counts));
});

app.post("/api/v1/saved-searches", async (c) => {
	const parsed = SavedSearchBody.safeParse(await c.req.json().catch(() => null));
	if (!parsed.success || parsed.data.query === undefined) return c.json({ error: "Invalid saved search" }, 400);
	const result = await mailStore(c.env).all().createSavedSearch({ name: parsed.data.name, query: parsed.data.query });
	return result.saved ? c.json(result.saved, 201) : c.json({ error: result.error }, 400);
});

app.put("/api/v1/saved-searches/:id", async (c) => {
	const parsed = SavedSearchBody.safeParse(await c.req.json().catch(() => null));
	if (!parsed.success) return c.json({ error: "Invalid saved search" }, 400);
	const result = await mailStore(c.env).all().updateSavedSearch(c.req.param("id"), parsed.data);
	if (result.error) return c.json({ error: result.error }, 400);
	return result.saved ? c.json(result.saved) : c.json({ error: "Not found" }, 404);
});

app.delete("/api/v1/saved-searches/:id", async (c) => {
	const deleted = await mailStore(c.env).all().deleteSavedSearch(c.req.param("id"));
	return deleted ? c.json({ deleted: true }) : c.json({ error: "Not found" }, 404);
});

// -- Labels ---------------------------------------------------------

app.get("/api/v1/labels", async (c) => c.json(await mailStore(c.env).all().listLabels()));

app.post("/api/v1/labels", async (c) => {
	const parsed = LabelBody.safeParse(await c.req.json().catch(() => null));
	if (!parsed.success) return c.json({ error: "Invalid label" }, 400);
	const result = await mailStore(c.env).all().createLabel({ name: parsed.data.name, color: parsed.data.color });
	return result.label ? c.json(result.label, 201) : c.json({ error: result.error }, 400);
});

app.put("/api/v1/labels/:id", async (c) => {
	const parsed = LabelBody.safeParse(await c.req.json().catch(() => null));
	if (!parsed.success) return c.json({ error: "Invalid label" }, 400);
	const result = await mailStore(c.env).all().updateLabel(c.req.param("id"), parsed.data);
	if (result.error) return c.json({ error: result.error }, 400);
	return result.label ? c.json(result.label) : c.json({ error: "Not found" }, 404);
});

app.delete("/api/v1/labels/:id", async (c) => {
	const result = await mailStore(c.env).all().deleteLabel(c.req.param("id"));
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

app.post("/api/v1/mailboxes/:mailboxId/emails", handleSendEmail);

app.post("/api/v1/mailboxes/:mailboxId/drafts", async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!;
	const { to, cc, bcc, subject, body, in_reply_to, thread_id, draft_id } = DraftBody.parse(await c.req.json());
	const stub = c.var.mailbox;
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

// -- Scheduled send -------------------------------------------------

/** Save the message as a draft and send it at sendAt from the mailbox's alarm. */
app.post("/api/v1/mailboxes/:mailboxId/scheduled", async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!;
	const raw = await c.req.text();
	if (new TextEncoder().encode(raw).byteLength > SCHEDULE_MAX_PAYLOAD_BYTES) {
		return c.json({ error: "Message is too large to schedule" }, 413);
	}
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		return c.json({ error: "Invalid JSON" }, 400);
	}
	const parsed = ScheduleBody.safeParse(json);
	if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid schedule request" }, 400);
	const { sendAt, draft_id, mode, original_id, email } = parsed.data;
	const sendAtError = checkSendAt(sendAt);
	if (sendAtError) return c.json({ error: sendAtError }, 400);
	try {
		validateSender(email.to, email.from, mailboxId);
	} catch (e) {
		if (e instanceof SenderValidationError) return c.json({ error: e.message }, 400);
		throw e;
	}
	const result = await c.var.mailbox.scheduleSend({
		mailboxId, sendAt, draftId: draft_id, mode, originalId: mode === "new" ? undefined : original_id, email,
	});
	if ("error" in result) return c.json({ error: result.error }, result.status);
	return c.json(result, 201);
});

app.delete("/api/v1/mailboxes/:mailboxId/scheduled/:emailId", async (c: AppContext) => {
	const cancelled = await c.var.mailbox.cancelScheduled(c.req.param("emailId")!);
	return cancelled ? c.json({ status: "cancelled" }) : c.json({ error: "Not found" }, 404);
});

app.get("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const email = await c.var.mailbox.getEmail(c.req.param("id")!);
	if (!email) return c.json({ error: "Email not found" }, 404);
	return new Response(JSON.stringify(email), {
		headers: { "Content-Type": "application/json" },
	});
});

// Delete moves mail to Trash. Only mail already in Trash, and drafts, are deleted permanently.
app.delete("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const id = c.req.param("id")!;
	const result = await c.var.mailbox.trashOrDelete(id);
	if (result === null) return c.json({ error: "Not found" }, 404);
	if (result.attachments.length > 0) await c.env.BUCKET.delete(result.attachments.map((att) => `attachments/${id}/${att.id}/${att.filename}`));
	return c.json({ status: result.action });
});

// -- Threads --------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/threads/:threadId", async (c: AppContext) => {
	return c.json(await (c.var.mailbox as any).getThreadEmails(c.req.param("threadId")!));
});

app.post("/api/v1/mailboxes/:mailboxId/threads/:threadId/read", async (c: AppContext) => {
	await c.var.mailbox.markThreadRead(c.req.param("threadId")!);
	return c.json({ status: "marked_read" });
});

// -- Reply / Forward ------------------------------------------------

app.post("/api/v1/mailboxes/:mailboxId/emails/:id/reply", handleReplyEmail);
app.post("/api/v1/mailboxes/:mailboxId/emails/:id/forward", handleForwardEmail);

// -- Attachments ----------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/emails/:emailId/attachments/:attachmentId", async (c: AppContext) => {
	const emailId = c.req.param("emailId")!;
	const attachmentId = c.req.param("attachmentId")!;
	const attachment = await c.var.mailbox.getAttachment(attachmentId);
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
	if (!(await mailStore(env).mailboxes.exists(mailboxId))) {
		// A configured address gets its mailbox on first delivery, so mail sent before anyone opens the app is kept.
		if (allowedAddresses.length === 0) { console.log(`Ignoring email for ${mailboxId}: mailbox does not exist`); return; }
		await createMailbox(env, mailboxId, mailboxId.split("@")[0] || mailboxId);
	}

	const stub = mailStore(env).mailbox(mailboxId);

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

	const inbound = {
		id: messageId, subject: parsedEmail.subject || "",
		sender: (parsedEmail.from?.address || "").toLowerCase(), recipient: allRecipients.join(", ") || mailboxId,
		cc: ccRecipients.join(", ") || null, bcc: bccRecipients.join(", ") || null,
		date: new Date().toISOString(), // uses receive time, not the email's Date header
		body: parsedEmail.html || parsedEmail.text || "",
		in_reply_to: inReplyTo, email_references: emailReferences.length > 0 ? JSON.stringify(emailReferences) : null,
		thread_id: threadId, message_id: originalMessageId, raw_headers: JSON.stringify(parsedEmail.headers),
	};
	await stub.createEmail(Folders.INBOX, inbound, attachmentData);
	// For two weeks after the move to D1, the old mailbox gets a copy too (store/copy-job.ts).
	if (usesD1(env)) {
		ctx.waitUntil(mirrorInbound(env, mailboxId, Folders.INBOX, inbound, attachmentData)
			.catch((e) => console.error(`inbound mirror failed for ${messageId}:`, (e as Error).message)));
	}

	const automated = automatedMailReason(JSON.stringify(parsedEmail.headers), parsedEmail.from?.address);
	if (String(env.AUTO_DRAFT_ENABLED) === "true" && automated) {
		console.log(`Auto-draft skipped for ${messageId}: ${automated}`);
	} else if (String(env.AUTO_DRAFT_ENABLED) === "true") {
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
