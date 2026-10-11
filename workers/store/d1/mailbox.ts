// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * One address's mail on D1, with the same methods and return shapes as
 * MailboxDO. Every query is scoped to the mailbox.
 */
import { Folders } from "../../../shared/folders";
import type { ScheduleMode, ScheduledPayload, ScheduledRow } from "../../lib/scheduled-send";
import type { SendEmailRequest } from "../../lib/send";
import { SEND_KEY_TTL_MS, type SendKeyClaim } from "../../lib/send-keys";
import type { Sql } from "../sql";
import {
	type AttachmentInput,
	BODY_INLINE_MAX,
	EMAIL_COLUMNS,
	type EmailInput,
	LIST_COLUMNS,
	SYSTEM_FOLDERS,
	bodyKey,
	conversationFor,
	conversationSql,
	insertStatements,
	normalizeSubject,
	toAttachmentRow,
	toEmailRow,
	toListRow,
	type AttachmentRow,
} from "./rows";

/** Folders whose mail may be hard-deleted. Everywhere else, Delete moves mail to Trash. */
const HARD_DELETE_FOLDERS: readonly string[] = [Folders.TRASH, Folders.DRAFT];
const SORT_COLUMNS: Record<string, string> = {
	id: "m.email_id", subject: "m.subject", sender: "m.sender_addr", recipient: "m.recipient",
	date: "m.date", read: "m.read", starred: "m.starred",
};
const FOLDER_NAMES: Record<string, string> = { inbox: "Inbox", sent: "Sent", draft: "Drafts", archive: "Archive", trash: "Trash", spam: "Spam" };
const SUBJECT_PREFIX = /^(?:(?:re|fwd?|fw|aw|wg|r[eé]f|sv)\s*:\s*)+/i;

interface SearchOptions {
	query: string;
	folder?: string;
	from?: string;
	to?: string;
	subject?: string;
	date_start?: string;
	date_end?: string;
	is_read?: boolean;
	is_starred?: boolean;
	has_attachment?: boolean;
	page?: number;
	limit?: number;
}

export class D1Mailbox {
	readonly #id: string;

	constructor(private readonly sql: Sql, private readonly bucket: R2Bucket, mailboxId: string) {
		this.#id = mailboxId.toLowerCase();
	}

	/** The mailbox row and its system folders, created on first write. */
	#ensureStatements() {
		return [
			{ sql: `INSERT OR IGNORE INTO mailboxes (id, created_at) VALUES (?, ?)`, params: [this.#id, new Date().toISOString()] },
			...SYSTEM_FOLDERS.map((f) => ({
				sql: `INSERT OR IGNORE INTO folders (mailbox_id, id, name, is_deletable) VALUES (?, ?, ?, 0)`,
				params: [this.#id, f, FOLDER_NAMES[f] ?? f],
			})),
		];
	}

	async #folderId(folder: string): Promise<string | null> {
		const row = await this.sql.first(`SELECT id FROM folders WHERE mailbox_id = ? AND (id = ? OR name = ?) LIMIT 1`, this.#id, folder, folder);
		return row ? String(row.id) : null;
	}

	async #body(row: Record<string, unknown>): Promise<string | null> {
		if (!row.body_key) return (row.body as string | null) ?? null;
		const object = await this.bucket.get(String(row.body_key));
		return object ? await object.text() : null;
	}

	async #attachments(emailIds: string[]) {
		if (emailIds.length === 0) return new Map<string, AttachmentRow[]>();
		const rows = await this.sql.all(
			`SELECT id, email_id, filename, mimetype, size, content_id, disposition FROM attachments WHERE email_id IN (SELECT value FROM json_each(?)) ORDER BY id`,
			JSON.stringify(emailIds),
		);
		const byEmail = new Map<string, AttachmentRow[]>();
		for (const row of rows.map(toAttachmentRow)) byEmail.set(row.email_id, [...(byEmail.get(row.email_id) ?? []), row]);
		return byEmail;
	}

	// ── Messages and threads ───────────────────────────────────────

	async getEmails(options: { folder?: string; thread_id?: string; page?: number; limit?: number; sortColumn?: string; sortDirection?: "ASC" | "DESC" } = {}) {
		const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);
		const offset = ((options.page ?? 1) - 1) * limit;
		const where = [`m.mailbox_id = ?`];
		const params: unknown[] = [this.#id];
		if (options.folder) {
			where.push(`m.folder_id = (SELECT id FROM folders WHERE mailbox_id = ? AND (name = ? OR id = ?) LIMIT 1)`);
			params.push(this.#id, options.folder, options.folder);
		}
		if (options.thread_id) {
			where.push(`m.thread_id = ?`);
			params.push(options.thread_id);
		}
		const order = SORT_COLUMNS[options.sortColumn ?? "date"] ?? SORT_COLUMNS.date;
		const rows = await this.sql.all(
			`SELECT ${LIST_COLUMNS} FROM messages m WHERE ${where.join(" AND ")}
			ORDER BY ${order} ${options.sortDirection === "ASC" ? "ASC" : "DESC"} LIMIT ? OFFSET ?`,
			...params, limit, offset,
		);
		return rows.map(toListRow);
	}

	async getEmail(id: string) {
		const row = await this.sql.first(`SELECT ${EMAIL_COLUMNS} FROM messages m WHERE m.mailbox_id = ? AND m.email_id = ?`, this.#id, id);
		if (!row) return null;
		const attachments = (await this.#attachments([id])).get(id) ?? [];
		return { ...toEmailRow(row, await this.#body(row)), attachments };
	}

	async getThreadEmails(threadId: string) {
		const rows = await this.sql.all(
			`SELECT ${EMAIL_COLUMNS} FROM messages m WHERE m.mailbox_id = ? AND m.thread_id = ? ORDER BY m.date ASC`,
			this.#id, threadId,
		);
		const attachments = await this.#attachments(rows.map((r) => String(r.id)));
		return Promise.all(rows.map(async (row) => ({
			...toEmailRow(row, await this.#body(row)),
			attachments: attachments.get(String(row.id)) ?? [],
		})));
	}

	async createEmail(folder: string, email: EmailInput, attachments: AttachmentInput[]) {
		await this.sql.batch(this.#ensureStatements());
		const folderId = await this.#folderId(folder);
		if (!folderId) {
			throw new Error(`createEmail: folder "${folder}" not found. Ensure the folder exists before inserting an email.`);
		}
		const subjectNorm = normalizeSubject(email.subject || "");
		const same = folderId === Folders.DRAFT || email.thread_id || !subjectNorm
			? null
			: await this.sql.first(conversationSql(), this.#id, subjectNorm);
		const conversationId = conversationFor(email, folderId, subjectNorm, (same?.id as string | null | undefined) ?? null);
		const bodyInR2 = new TextEncoder().encode(email.body ?? "").length > BODY_INLINE_MAX;
		if (bodyInR2) await this.bucket.put(bodyKey(email.id), email.body, { httpMetadata: { contentType: "text/html" } });
		await this.sql.batch(insertStatements(this.#id, folderId, email, attachments, conversationId, { bodyInR2 }));
	}

	async updateEmail(id: string, { read, starred }: { read?: boolean; starred?: boolean }) {
		const sets: string[] = [];
		const params: unknown[] = [];
		if (read !== undefined) { sets.push("read = ?"); params.push(read ? 1 : 0); }
		if (starred !== undefined) { sets.push("starred = ?"); params.push(starred ? 1 : 0); }
		if (sets.length > 0) await this.sql.run(`UPDATE messages SET ${sets.join(", ")} WHERE mailbox_id = ? AND email_id = ?`, ...params, this.#id, id);
		return this.getEmail(id);
	}

	async markThreadRead(threadId: string) {
		const ids = (await this.sql.all(
			`UPDATE messages SET read = 1 WHERE mailbox_id = ? AND thread_id = ? AND read = 0 RETURNING email_id`,
			this.#id, threadId,
		)).map((r) => String(r.email_id));
		return { threadId, markedRead: true, ids };
	}

	/** Permanently delete an email. Only mail in Trash or Drafts can be deleted. */
	async deleteEmail(id: string) {
		const row = await this.sql.first(`SELECT folder_id, body_key FROM messages WHERE mailbox_id = ? AND email_id = ?`, this.#id, id);
		if (!row) return null;
		if (!HARD_DELETE_FOLDERS.includes(String(row.folder_id))) throw new Error("Only mail in Trash or Drafts can be deleted");
		const [attachments] = await this.sql.batch([
			{ sql: `SELECT id, filename FROM attachments WHERE email_id = ? ORDER BY id`, params: [id] },
			{ sql: `DELETE FROM messages WHERE mailbox_id = ? AND email_id = ?`, params: [this.#id, id] },
		]);
		if (row.body_key) await this.bucket.delete(String(row.body_key)).catch(() => {});
		return attachments.map((a) => ({ id: String(a.id), filename: String(a.filename) }));
	}

	async trashOrDelete(id: string): Promise<
		| { action: "trashed"; attachments: [] }
		| { action: "deleted"; attachments: { id: string; filename: string }[] }
		| null
	> {
		const row = await this.sql.first(`SELECT folder_id FROM messages WHERE mailbox_id = ? AND email_id = ?`, this.#id, id);
		if (!row) return null;
		if (HARD_DELETE_FOLDERS.includes(String(row.folder_id))) {
			const attachments = await this.deleteEmail(id);
			return attachments === null ? null : { action: "deleted", attachments };
		}
		await this.moveEmail(id, Folders.TRASH);
		return { action: "trashed", attachments: [] };
	}

	async moveEmail(id: string, folderId: string) {
		const folder = await this.sql.first(
			`SELECT f.id, m.folders_imported FROM folders f JOIN mailboxes m ON m.id = f.mailbox_id WHERE f.mailbox_id = ? AND f.id = ?`,
			this.#id, folderId,
		);
		if (!folder) return false;
		if (!SYSTEM_FOLDERS.includes(folderId) && folder.folders_imported) return false;
		await this.sql.run(`UPDATE messages SET folder_id = ? WHERE mailbox_id = ? AND email_id = ?`, folderId, this.#id, id);
		return true;
	}

	async getAttachment(id: string): Promise<AttachmentRow | null> {
		const row = await this.sql.first(
			`SELECT a.id, a.email_id, a.filename, a.mimetype, a.size, a.content_id, a.disposition FROM attachments a
			JOIN messages m ON m.email_id = a.email_id WHERE a.id = ? AND m.mailbox_id = ?`,
			id, this.#id,
		);
		return row ? toAttachmentRow(row) : null;
	}

	async findThreadBySubject(subject: string, senderAddress?: string): Promise<string | null> {
		const normalized = subject.replace(SUBJECT_PREFIX, "").trim().toLowerCase();
		if (!normalized) return null;
		const rows = await this.sql.all(
			`SELECT thread_id, subject, GROUP_CONCAT(DISTINCT LOWER(sender_addr)) AS senders, GROUP_CONCAT(DISTINCT LOWER(recipient)) AS recipients
			FROM messages
			WHERE mailbox_id = ? AND thread_id IS NOT NULL AND thread_id != email_id AND date >= ?
			GROUP BY thread_id ORDER BY MAX(date) DESC LIMIT 50`,
			this.#id, new Date(Date.now() - 7 * 86_400_000).toISOString(),
		);
		const sender = senderAddress?.toLowerCase().trim();
		for (const row of rows) {
			if (String(row.subject ?? "").replace(SUBJECT_PREFIX, "").trim().toLowerCase() !== normalized) continue;
			if (sender && !`${row.senders ?? ""},${row.recipients ?? ""}`.includes(sender)) continue;
			return String(row.thread_id);
		}
		return null;
	}

	// ── Folder import ──────────────────────────────────────────────

	async folderImportCounts() {
		const [folders, mailbox] = await this.sql.batch([
			{
				sql: `SELECT f.id AS folderId, f.name AS name, COUNT(m.id) AS count FROM folders f
					LEFT JOIN messages m ON m.mailbox_id = f.mailbox_id AND m.folder_id = f.id
					WHERE f.mailbox_id = ? AND f.id NOT IN (SELECT value FROM json_each(?))
					GROUP BY f.id, f.name ORDER BY f.id`,
				params: [this.#id, JSON.stringify(SYSTEM_FOLDERS)],
			},
			{ sql: `SELECT folders_imported FROM mailboxes WHERE id = ?`, params: [this.#id] },
		]);
		return {
			folders: folders.map((r) => ({ folderId: String(r.folderId), name: String(r.name), count: Number(r.count) })),
			imported: !!mailbox[0]?.folders_imported,
		};
	}

	async folderEmailIds(folderId: string) {
		return (await this.sql.all(`SELECT email_id FROM messages WHERE mailbox_id = ? AND folder_id = ? ORDER BY email_id`, this.#id, folderId))
			.map((r) => String(r.email_id));
	}

	/** Label the folder's mail, then move labeled mail still in the folder to Archive. Safe to run again. */
	async importFolder(folderId: string, labelId: string) {
		if (SYSTEM_FOLDERS.includes(folderId)) throw new Error("System folders are not imported");
		const [labeled, archived] = await this.sql.batch([
			{
				sql: `INSERT OR IGNORE INTO message_labels (message, label_id) SELECT id, ? FROM messages WHERE mailbox_id = ? AND folder_id = ? RETURNING message`,
				params: [labelId, this.#id, folderId],
			},
			{
				sql: `UPDATE messages SET folder_id = ? WHERE mailbox_id = ? AND folder_id = ?
					AND id IN (SELECT message FROM message_labels WHERE label_id = ?) RETURNING id`,
				params: [Folders.ARCHIVE, this.#id, folderId, labelId],
			},
		]);
		return { labeled: labeled.length, archived: archived.length };
	}

	async markFoldersImported() {
		await this.sql.run(`UPDATE mailboxes SET folders_imported = 1 WHERE id = ?`, this.#id);
		return { imported: true };
	}

	// ── Per-address search (the agent's and MCP's search_emails) ───

	async searchEmails(options: SearchOptions) {
		const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);
		const offset = ((options.page ?? 1) - 1) * limit;
		const where = [`m.mailbox_id = ?`];
		const params: unknown[] = [this.#id];
		const like = (v: string) => `%${v}%`;
		if (options.query) {
			where.push(`(m.subject LIKE ? OR m.body LIKE ? OR m.sender_addr LIKE ? OR m.recipient LIKE ? OR m.cc LIKE ? OR m.bcc LIKE ?)`);
			params.push(...Array(6).fill(like(options.query)));
		}
		if (options.folder) {
			where.push(`m.folder_id = (SELECT id FROM folders WHERE mailbox_id = ? AND (name = ? OR id = ?) LIMIT 1)`);
			params.push(this.#id, options.folder, options.folder);
		}
		if (options.from) { where.push(`m.sender_addr LIKE ?`); params.push(like(options.from)); }
		if (options.to) { where.push(`(m.recipient LIKE ? OR m.cc LIKE ? OR m.bcc LIKE ?)`); params.push(...Array(3).fill(like(options.to))); }
		if (options.subject) { where.push(`m.subject LIKE ?`); params.push(like(options.subject)); }
		if (options.date_start) { where.push(`m.date >= ?`); params.push(options.date_start); }
		if (options.date_end) { where.push(`m.date <= ?`); params.push(options.date_end); }
		if (options.is_read !== undefined) { where.push(`m.read = ?`); params.push(options.is_read ? 1 : 0); }
		if (options.is_starred !== undefined) { where.push(`m.starred = ?`); params.push(options.is_starred ? 1 : 0); }
		if (options.has_attachment) where.push(`m.email_id IN (SELECT DISTINCT email_id FROM attachments)`);
		const rows = await this.sql.all(
			`SELECT ${LIST_COLUMNS}, f.name AS folder_name
			FROM messages m LEFT JOIN folders f ON f.mailbox_id = m.mailbox_id AND f.id = m.folder_id
			WHERE ${where.join(" AND ")} ORDER BY m.date DESC LIMIT ? OFFSET ?`,
			...params, limit, offset,
		);
		return rows.map((r) => ({ ...toListRow(r), folder_name: (r.folder_name as string | null) ?? null }));
	}

	// ── Sending ────────────────────────────────────────────────────

	/** 20 sends an hour and 100 a day per address. Null when under the limit. */
	async checkSendRateLimit(): Promise<string | null> {
		const now = Date.now();
		const row = await this.sql.first(
			`SELECT COALESCE(SUM(date >= ?), 0) AS hour, COUNT(*) AS day FROM messages WHERE mailbox_id = ? AND folder_id = ? AND date >= ?`,
			new Date(now - 3_600_000).toISOString(), this.#id, Folders.SENT, new Date(now - 86_400_000).toISOString(),
		);
		if (Number(row?.hour ?? 0) >= 20) return "Rate limit exceeded: max 20 emails per hour per mailbox";
		if (Number(row?.day ?? 0) >= 100) return "Rate limit exceeded: max 100 emails per day per mailbox";
		return null;
	}

	async claimSendKey(key: string): Promise<SendKeyClaim> {
		const now = Date.now();
		const [, inserted] = await this.sql.batch([
			{ sql: `DELETE FROM send_keys WHERE created_at < ?`, params: [new Date(now - SEND_KEY_TTL_MS).toISOString()] },
			{
				sql: `INSERT INTO send_keys (mailbox_id, key, state, created_at) VALUES (?, ?, 'pending', ?) ON CONFLICT DO NOTHING RETURNING state`,
				params: [this.#id, key, new Date(now).toISOString()],
			},
		]);
		if (inserted.length > 0) return { state: "new" };
		const row = await this.sql.first(`SELECT state, email_id FROM send_keys WHERE mailbox_id = ? AND key = ?`, this.#id, key);
		return row?.state === "sent" ? { state: "sent", id: String(row.email_id) } : { state: "pending" };
	}

	async finishSendKey(key: string, emailId: string): Promise<void> {
		await this.sql.run(`UPDATE send_keys SET state = 'sent', email_id = ? WHERE mailbox_id = ? AND key = ?`, emailId, this.#id, key);
	}

	async releaseSendKey(key: string): Promise<void> {
		await this.sql.run(`DELETE FROM send_keys WHERE mailbox_id = ? AND key = ? AND state = 'pending'`, this.#id, key);
	}

	// ── Scheduled send ─────────────────────────────────────────────
	//
	// The message waits as a draft; scheduled_sends holds the request. The cron
	// sends due rows (docs/d1-migration-plan.md, phase 4). Deleting the draft
	// drops its schedule by foreign key.

	async scheduleSend(input: {
		mailboxId?: string;
		sendAt: string;
		draftId?: string;
		mode: ScheduleMode;
		originalId?: string;
		email: SendEmailRequest;
	}): Promise<{ id: string; sendAt: string } | { error: string; status: 404 }> {
		const { email, mode, originalId } = input;
		let threadId: string | null = null;
		if (originalId && mode !== "new") {
			const raw = await this.getEmail(originalId);
			if (!raw) return { error: "Original email not found", status: 404 };
			const original = raw.folder_id === Folders.DRAFT && raw.in_reply_to ? (await this.getEmail(raw.in_reply_to)) ?? raw : raw;
			if (mode !== "forward") threadId = original.thread_id || original.id;
		}
		const join = (v?: string | string[]) => (v ? (Array.isArray(v) ? v.join(", ") : v).toLowerCase() : null);
		const id = crypto.randomUUID();
		const sendAt = new Date(input.sendAt).toISOString();
		await this.createEmail(Folders.DRAFT, {
			id, subject: email.subject || "", sender: this.#id,
			recipient: join(email.to) ?? "", cc: join(email.cc), bcc: join(email.bcc),
			date: new Date().toISOString(), body: email.html || email.text || "",
			in_reply_to: originalId || null, email_references: null,
			thread_id: threadId || originalId || id,
		}, []);
		const payload: ScheduledPayload = { mode, original_id: originalId, email };
		await this.sql.run(
			`INSERT OR REPLACE INTO scheduled_sends (email_id, mailbox_id, send_at, payload, attempts, error) VALUES (?, ?, ?, ?, 0, NULL)`,
			id, this.#id, sendAt, JSON.stringify(payload),
		);
		if (input.draftId && input.draftId !== id) {
			const old = await this.getEmail(input.draftId);
			if (old?.folder_id === Folders.DRAFT) await this.deleteEmail(input.draftId);
		}
		return { id, sendAt };
	}

	async listScheduled(): Promise<ScheduledRow[]> {
		return (await this.sql.all(
			`SELECT email_id, send_at, attempts, error FROM scheduled_sends WHERE mailbox_id = ? ORDER BY send_at, email_id`,
			this.#id,
		)).map((r) => ({ emailId: String(r.email_id), sendAt: String(r.send_at), attempts: Number(r.attempts), error: r.error == null ? null : String(r.error) }));
	}

	/** Drop the schedule only; the draft stays in Drafts. */
	async cancelScheduled(emailId: string): Promise<boolean> {
		return (await this.sql.all(`DELETE FROM scheduled_sends WHERE mailbox_id = ? AND email_id = ? RETURNING email_id`, this.#id, emailId)).length > 0;
	}
}
