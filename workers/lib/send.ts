// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The one sending path: new mail, replies and forwards from the API routes,
 * and scheduled sends from the cron.
 */
import type { z } from "zod";
import { sendEmail } from "../email-sender";
import { storeAttachments } from "./attachments";
import {
	buildReferencesChain,
	buildThreadingHeaders,
	generateMessageId,
	resolveOriginalEmail,
	SenderValidationError,
	validateSender,
} from "./email-helpers";
import { hasHeaderLineBreaks } from "./schemas";
import type { EmailFull, SendEmailRequestSchema } from "./schemas";
import { SEND_KEY_PENDING_ERROR, type SendKeyClaim } from "./send-keys";
import { Folders } from "../../shared/folders";
import type { Env } from "../types";

export type SendEmailRequest = z.infer<typeof SendEmailRequestSchema>;

export type SendMode =
	| { kind: "new" }
	| { kind: "reply"; originalId: string }
	| { kind: "forward"; originalId: string };

/** What sending needs from a mailbox (a `MailboxStore`). */
export interface SendStub {
	getEmail(id: string): Promise<unknown>;
	createEmail(folder: string, email: any, attachments: any[]): Promise<unknown>;
	checkSendRateLimit(): Promise<string | null>;
	markThreadRead(threadId: string): Promise<unknown>;
	claimSendKey(key: string): Promise<SendKeyClaim>;
	finishSendKey(key: string, emailId: string): Promise<void>;
	releaseSendKey(key: string): Promise<void>;
}

export type SendResult =
	| { ok: true; id: string; duplicate?: true }
	| { ok: false; status: 400 | 404 | 409 | 429; error: string };

export interface SendOptions {
	/**
	 * Hand delivery to the caller (e.g. waitUntil) after the Sent copy is
	 * stored. Without it, delivery runs first and a failure throws before
	 * anything is stored, so the caller can retry.
	 */
	defer?: (delivery: Promise<unknown>) => void;
	/**
	 * Send at most once per key (see send-keys.ts). A repeat with a key that
	 * already sent returns the first send's id with `duplicate: true`.
	 */
	idempotencyKey?: string;
}

const DEFERRED_LABEL: Record<SendMode["kind"], string> = { new: "email", reply: "reply", forward: "forward" };

const joinList = (value: string | string[]) => (Array.isArray(value) ? value.join(", ") : value);

export async function sendMail(
	env: Env,
	mailboxId: string,
	stub: SendStub,
	body: SendEmailRequest,
	mode: SendMode,
	options: SendOptions = {},
): Promise<SendResult> {
	const key = options.idempotencyKey;
	if (!key) return sendOnce(env, mailboxId, stub, body, mode, options, () => {});

	const claim = await stub.claimSendKey(key);
	if (claim.state === "sent") return { ok: true, id: claim.id, duplicate: true };
	if (claim.state === "pending") return { ok: false, status: 409, error: SEND_KEY_PENDING_ERROR };

	// Once delivery may have happened the key stays claimed, even if storing the Sent copy fails.
	let delivered = false;
	try {
		const result = await sendOnce(env, mailboxId, stub, body, mode, options, () => { delivered = true; });
		if (result.ok) await stub.finishSendKey(key, result.id);
		else await stub.releaseSendKey(key);
		return result;
	} catch (e) {
		if (!delivered) await stub.releaseSendKey(key);
		throw e;
	}
}

async function sendOnce(
	env: Env,
	mailboxId: string,
	stub: SendStub,
	body: SendEmailRequest,
	mode: SendMode,
	options: SendOptions,
	onDelivered: () => void,
): Promise<SendResult> {
	const { to, cc, bcc, from, subject, html, text, attachments } = body;

	// Threading for this send.
	let inReplyTo: string | null = null;
	let references: string[] = [];
	let threadId: string | null = null;
	let markRead: string | null = null;
	if (mode.kind !== "new") {
		const rawOriginal = (await stub.getEmail(mode.originalId)) as EmailFull | null;
		if (!rawOriginal) return { ok: false, status: 404, error: "Original email not found" };
		const original = await resolveOriginalEmail(stub, rawOriginal);
		if (mode.kind === "reply") {
			const chain = buildReferencesChain(original);
			inReplyTo = chain.originalMsgId;
			references = chain.references;
			threadId = chain.threadId;
			markRead = chain.threadId;
		}
	} else {
		inReplyTo = body.in_reply_to || null;
		references = body.references || [];
		threadId = body.thread_id || body.in_reply_to || null;
	}
	if (hasHeaderLineBreaks(subject, inReplyTo, ...references)) {
		return { ok: false, status: 400, error: "Email headers must not contain line breaks" };
	}

	let toStr: string, fromEmail: string, fromDomain: string;
	try {
		({ toStr, fromEmail, fromDomain } = validateSender(to, from, mailboxId));
	} catch (e) {
		if (e instanceof SenderValidationError) return { ok: false, status: 400, error: e.message };
		throw e;
	}

	const { messageId, outgoingMessageId } = generateMessageId(fromDomain);
	const rateLimitError = await stub.checkSendRateLimit();
	if (rateLimitError) return { ok: false, status: 429, error: rateLimitError };

	const deliver = () =>
		sendEmail(env.EMAIL, {
			to, cc, bcc, from, subject, html, text,
			attachments: attachments?.map((att) => ({
				content: att.content, filename: att.filename, type: att.type,
				disposition: att.disposition || "attachment", contentId: att.contentId,
			})),
			...(inReplyTo ? { headers: buildThreadingHeaders(inReplyTo, references) } : {}),
		});

	if (!options.defer) {
		await deliver();
		onDelivered();
	}

	const attachmentData = await storeAttachments(env.BUCKET, messageId, attachments);
	const now = new Date().toISOString();
	await stub.createEmail(Folders.SENT, {
		id: messageId, subject, sender: fromEmail, recipient: toStr,
		cc: cc ? joinList(cc).toLowerCase() : null,
		bcc: bcc ? joinList(bcc).toLowerCase() : null,
		date: now, body: html || text || "",
		in_reply_to: inReplyTo,
		email_references: mode.kind === "reply" || (mode.kind === "new" && body.references)
			? JSON.stringify(references)
			: null,
		thread_id: threadId || messageId,
		message_id: outgoingMessageId,
		raw_headers: JSON.stringify([
			{ key: "from", value: typeof from === "string" ? from : `${from.name} <${from.email}>` },
			{ key: "to", value: joinList(to) },
			...(cc ? [{ key: "cc", value: joinList(cc) }] : []),
			...(bcc ? [{ key: "bcc", value: joinList(bcc) }] : []),
			{ key: "subject", value: subject },
			{ key: "date", value: now },
			{ key: "message-id", value: `<${outgoingMessageId}>` },
			...(mode.kind === "reply" && inReplyTo ? [{ key: "in-reply-to", value: `<${inReplyTo}>` }] : []),
			...(mode.kind === "reply" && references.length > 0
				? [{ key: "references", value: references.map((r) => `<${r}>`).join(" ") }]
				: []),
		]),
	}, attachmentData);

	if (markRead) await stub.markThreadRead(markRead);

	if (options.defer) {
		onDelivered();
		const label = DEFERRED_LABEL[mode.kind];
		options.defer(deliver().catch((e) => {
			console.error(`Deferred ${label} delivery failed:`, (e as Error).message);
		}));
	}
	return { ok: true, id: messageId };
}
