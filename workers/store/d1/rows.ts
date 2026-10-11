// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * How a message is stored on D1: the row with the index's derived columns,
 * its search rows, and the shape callers get back (today's `emails` row plus
 * attachments, as MailboxDO returns it).
 */
import { Folders } from "../../../shared/folders";
import { htmlToText, listHeaders, parseSender } from "../../lib/message-meta";
import type { Statement } from "../sql";

export const SYSTEM_FOLDERS: readonly string[] = Object.values(Folders);
/** Bodies larger than this live in R2 (docs/d1-migration-plan.md, Large bodies). */
export const BODY_INLINE_MAX = 512 * 1024;
const SNIPPET_LENGTH = 200;

export interface EmailInput {
	id: string;
	subject: string;
	sender: string;
	recipient: string;
	cc?: string | null;
	bcc?: string | null;
	date: string;
	body: string;
	read?: boolean;
	starred?: boolean;
	in_reply_to?: string | null;
	email_references?: string | null;
	thread_id?: string | null;
	message_id?: string | null;
	raw_headers?: string | null;
}

export interface AttachmentInput {
	id: string;
	email_id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id?: string | null;
	disposition?: string | null;
}

/** Same normalization as MailboxDO and the index, in JavaScript. */
export function normalizeSubject(subject: string): string {
	let s = subject.toLowerCase();
	for (const prefix of ["aw: ", "wg: ", "réf: ", "sv: ", "re: ", "fwd: ", "fw: "]) s = s.split(prefix).join("");
	return s.trim().toLowerCase();
}

/** `has:link`: the body holds a web address. The cron's backfill applies the same test in SQL (LINK_SQL). */
export function hasLink(body: string | null | undefined): boolean {
	return !!body && /https?:\/\//i.test(body);
}

export const LINK_SQL = `(body LIKE '%http://%' OR body LIKE '%https://%')`;

export const bodyKey = (emailId: string) => `bodies/${emailId}.html`;

/**
 * The conversation a new message joins, as the index computes it: a reply
 * draft groups with what it replies to, threaded mail with its thread, and
 * unthreaded mail with the earliest message of the same subject.
 */
export function conversationSql(): string {
	return `SELECT MIN(COALESCE(thread_id, email_id)) AS id FROM messages
		WHERE mailbox_id = ? AND folder_id != '${Folders.DRAFT}' AND subject_norm = ?`;
}

export function conversationFor(email: EmailInput, folderId: string, subjectNorm: string, sameSubject: string | null): string {
	if (folderId === Folders.DRAFT) return email.in_reply_to || email.id;
	if (email.thread_id) return email.thread_id;
	if (!subjectNorm) return email.id;
	// The index takes the minimum over the subject group including this message.
	return sameSubject !== null && sameSubject < email.id ? sameSubject : email.id;
}

/** Statements that store one message, its attachments and its search rows. */
export function insertStatements(
	mailboxId: string,
	folderId: string,
	email: EmailInput,
	attachments: AttachmentInput[],
	conversationId: string,
	options: { bodyInR2: boolean },
): Statement[] {
	const sender = parseSender(email.sender, email.raw_headers ?? null);
	const list = listHeaders(email.raw_headers ?? null);
	const bodyText = htmlToText(email.body);
	const subjectNorm = normalizeSubject(email.subject || "");
	const recipients = [email.recipient, email.cc, email.bcc].filter(Boolean).join(", ").toLowerCase();
	const visible = attachments.filter((a) => (a.disposition ?? "attachment") !== "inline");
	const attachmentNames = visible.map((a) => a.filename).join(" ");
	const size = new TextEncoder().encode(email.body ?? "").length + attachments.reduce((n, a) => n + a.size, 0);
	const read = folderId === Folders.SENT ? 1 : email.read ? 1 : 0;
	const rowid = `(SELECT id FROM messages WHERE email_id = ?)`;
	return [
		{
			sql: `INSERT INTO messages (email_id, mailbox_id, folder_id, thread_id, conversation_id, message_id, in_reply_to,
				email_references, date, subject, subject_norm, sender_addr, sender_name, sender_domain, recipient, cc, bcc,
				recipients, snippet, body, body_key, raw_headers, size, read, starred, has_attachment, list_id, unsubscribe, has_link)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			params: [
				email.id, mailboxId, folderId, email.thread_id ?? null, conversationId, email.message_id ?? null, email.in_reply_to ?? null,
				email.email_references ?? null, email.date, email.subject ?? "", subjectNorm, sender.addr, sender.name, sender.domain,
				email.recipient ?? "", email.cc ?? null, email.bcc ?? null, recipients, bodyText.slice(0, SNIPPET_LENGTH),
				options.bodyInR2 ? null : email.body, options.bodyInR2 ? bodyKey(email.id) : null, email.raw_headers ?? null,
				size, read, email.starred ? 1 : 0, visible.length > 0 ? 1 : 0, list.list_id, list.unsubscribe, hasLink(email.body) ? 1 : 0,
			],
		},
		...attachments.map((a) => ({
			sql: `INSERT INTO attachments (id, email_id, filename, mimetype, size, content_id, disposition) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			params: [a.id, email.id, a.filename, a.mimetype, a.size, a.content_id ?? null, a.disposition ?? null],
		})),
		{
			sql: `INSERT INTO messages_fts (rowid, subject, sender_name, sender_addr, recipients, body_text, attachment_names)
				VALUES (${rowid}, ?, ?, ?, ?, ?, ?)`,
			params: [email.id, email.subject ?? "", sender.name, sender.addr, recipients, bodyText, attachmentNames],
		},
		{
			sql: `INSERT INTO messages_trigram (rowid, subject, sender_addr, recipients, attachment_names) VALUES (${rowid}, ?, ?, ?, ?)`,
			params: [email.id, email.subject ?? "", sender.addr, recipients, attachmentNames],
		},
	];
}

/** Columns that read back as today's `emails` row. */
export const EMAIL_COLUMNS = `m.email_id AS id, m.folder_id, m.subject, m.sender_addr AS sender, m.recipient, m.cc, m.bcc, m.date,
	m.read, m.starred, m.body, m.body_key, m.in_reply_to, m.email_references, m.thread_id, m.message_id, m.raw_headers`;

export interface EmailRow {
	id: string;
	folder_id: string;
	subject: string | null;
	sender: string | null;
	recipient: string | null;
	cc: string | null;
	bcc: string | null;
	date: string | null;
	read: boolean;
	starred: boolean;
	body: string | null;
	in_reply_to: string | null;
	email_references: string | null;
	thread_id: string | null;
	message_id: string | null;
	raw_headers: string | null;
}

export function toEmailRow(row: Record<string, unknown>, body: string | null): EmailRow {
	return {
		id: String(row.id),
		folder_id: String(row.folder_id),
		subject: (row.subject as string | null) ?? null,
		sender: (row.sender as string | null) ?? null,
		recipient: (row.recipient as string | null) ?? null,
		cc: (row.cc as string | null) ?? null,
		bcc: (row.bcc as string | null) ?? null,
		date: (row.date as string | null) ?? null,
		read: !!row.read,
		starred: !!row.starred,
		body,
		in_reply_to: (row.in_reply_to as string | null) ?? null,
		email_references: (row.email_references as string | null) ?? null,
		thread_id: (row.thread_id as string | null) ?? null,
		message_id: (row.message_id as string | null) ?? null,
		raw_headers: (row.raw_headers as string | null) ?? null,
	};
}

/** A list or search row: today's `getEmails` shape. */
export interface ListRow {
	id: string;
	subject: string | null;
	sender: string | null;
	recipient: string | null;
	cc: string | null;
	bcc: string | null;
	date: string | null;
	read: boolean;
	starred: boolean;
	in_reply_to: string | null;
	email_references: string | null;
	thread_id: string | null;
	folder_id: string;
	snippet: string;
}

export const LIST_COLUMNS = `m.email_id AS id, m.subject, m.sender_addr AS sender, m.recipient, m.cc, m.bcc, m.date, m.read, m.starred,
	m.in_reply_to, m.email_references, m.thread_id, m.folder_id, m.snippet`;

export function toListRow(row: Record<string, unknown>): ListRow {
	const text = (key: string) => (row[key] as string | null) ?? null;
	return {
		id: String(row.id), subject: text("subject"), sender: text("sender"), recipient: text("recipient"), cc: text("cc"), bcc: text("bcc"),
		date: text("date"), read: !!row.read, starred: !!row.starred, in_reply_to: text("in_reply_to"),
		email_references: text("email_references"), thread_id: text("thread_id"), folder_id: String(row.folder_id), snippet: String(row.snippet ?? ""),
	};
}

export interface AttachmentRow {
	id: string;
	email_id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id: string | null;
	disposition: string | null;
}

export function toAttachmentRow(row: Record<string, unknown>): AttachmentRow {
	return {
		id: String(row.id), email_id: String(row.email_id), filename: String(row.filename), mimetype: String(row.mimetype),
		size: Number(row.size), content_id: (row.content_id as string | null) ?? null, disposition: (row.disposition as string | null) ?? null,
	};
}
