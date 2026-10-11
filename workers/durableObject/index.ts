// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { DurableObject } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { eq, and, or, asc, desc, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import * as schema from "../db/schema";
import { Folders } from "../../shared/folders";
import type { Env } from "../types";
import { applyMigrations, mailboxMigrations } from "./migrations";
import { fromSqlStorage, type Exec } from "../lib/sql-exec";
import {
	ackOutbox,
	currentSeq,
	exportIndexRows,
	getMeta,
	mailboxCounts,
	pendingCount,
	readOutbox,
	recordChanges,
	setMeta,
} from "../lib/index-rows";
import { indexSyncEnabled } from "../lib/mail-index-stub";
import { durableObjectInternals } from "../store";
import {
	customFolderCounts,
	folderEmailIdsSql,
	foldersImported,
	importFolderArchiveSql,
	importFolderLabelSql,
	isSystemFolder,
	moveEmailsSql,
	purgeTrashSql,
	setLabelsSql,
	updateEmailsSql,
} from "../lib/mailbox-bulk";
import { sendMail, type SendEmailRequest } from "../lib/send";
import {
	deleteScheduledRow,
	insertScheduled,
	listScheduledRows,
	nextScheduledAt,
	runDueScheduled,
	sendModeOf,
	type ScheduleMode,
} from "../lib/scheduled-send";
import { claimSendKey, finishSendKey, releaseSendKey, type SendKeyClaim } from "../lib/send-keys";

/** Folders whose mail may be hard-deleted. Everywhere else, Delete moves mail to Trash. */
const HARD_DELETE_FOLDERS: readonly string[] = [Folders.TRASH, Folders.DRAFT];
const PUSH_BATCHES_PER_FLUSH = 50;
const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;

/**
 * SQL expression to normalize email subjects by stripping common
 * reply/forward prefixes (Re:, Fwd:, FW:, AW:, WG:, Réf:, SV:).
 * Used for conversation grouping. Hardcoded to the `subject` column.
 */
const NORMALIZED_SUBJECT_SQL = `LOWER(TRIM(
	REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
		LOWER(subject),
		'aw: ', ''), 'wg: ', ''), 'réf: ', ''), 'sv: ', ''),
		're: ', ''), 'fwd: ', ''), 'fw: ', '')
))`;

const ALLOWED_SORT_COLUMNS = [
	"id",
	"subject",
	"sender",
	"recipient",
	"date",
	"read",
	"starred",
] as const;

type SortColumn = (typeof ALLOWED_SORT_COLUMNS)[number];

/**
 * Map SortColumn string names to Drizzle column references for safe
 * ORDER BY construction (no string interpolation into SQL).
 */
const SORT_COLUMN_MAP = {
	id: schema.emails.id,
	subject: schema.emails.subject,
	sender: schema.emails.sender,
	recipient: schema.emails.recipient,
	date: schema.emails.date,
	read: schema.emails.read,
	starred: schema.emails.starred,
} satisfies Record<SortColumn, typeof schema.emails[keyof typeof schema.emails]>;

interface SearchFilterOptions {
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
}

interface GetEmailsOptions {
	folder?: string;
	thread_id?: string;
	page?: number;
	offset?: number;
	limit?: number;
	sortColumn?: SortColumn;
	sortDirection?: "ASC" | "DESC";
}

interface EmailData {
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

interface AttachmentData {
	id: string;
	email_id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id?: string | null;
	disposition?: string | null;
}

export class MailboxDO extends DurableObject<Env> {
	declare __DURABLE_OBJECT_BRAND: never;
	db: ReturnType<typeof drizzle>;
	exec: Exec;
	#flushing: Promise<void> | null = null;
	#flushAgain = false;

	constructor(state: DurableObjectState, env: Env) {
		super(state, env);
		this.db = drizzle(this.ctx.storage, { schema });
		this.exec = fromSqlStorage(this.ctx.storage.sql);
		applyMigrations(this.ctx.storage.sql, mailboxMigrations, this.ctx.storage);
	}

	// ── Mail index sync ────────────────────────────────────────────
	//
	// Every mutation records the changed email ids in index_outbox inside the
	// same transaction, then pushes their current state to MailIndexDO. A
	// failed push retries from an alarm; the index ignores stale rows.

	/** Run a mutation and record the ids it returns in the outbox atomically, then push. */
	async #change<T>(mutate: () => { result: T; ids: string[] }): Promise<T> {
		const { result, ids } = this.ctx.storage.transactionSync(() => {
			const out = mutate();
			recordChanges(this.exec, out.ids);
			return out;
		});
		if (ids.length > 0) await this.flushIndex();
		return result;
	}

	#mailboxId(): string | null {
		return getMeta(this.exec, "mailbox_id") ?? this.ctx.id.name ?? null;
	}

	/** Tell this mailbox its own address. Durable Objects cannot read their name. */
	async setMailboxId(mailboxId: string) {
		const id = mailboxId.toLowerCase();
		if (getMeta(this.exec, "mailbox_id") !== id) setMeta(this.exec, "mailbox_id", id);
		await this.flushIndex();
		return { mailboxId: id };
	}

	/** Push pending outbox rows. Serialized per instance; never throws. */
	async flushIndex(): Promise<void> {
		if (this.#flushing) {
			this.#flushAgain = true;
			return this.#flushing;
		}
		this.#flushing = (async () => {
			try {
				do {
					this.#flushAgain = false;
					await this.#pushOutbox();
				} while (this.#flushAgain);
				if (getMeta(this.exec, "retry_ms")) setMeta(this.exec, "retry_ms", "");
			} catch (e) {
				console.error("index push failed:", (e as Error).message);
				await this.#scheduleRetry();
			} finally {
				this.#flushing = null;
			}
		})();
		return this.#flushing;
	}

	async #pushOutbox(): Promise<void> {
		if (!indexSyncEnabled(this.env)) return;
		const mailboxId = this.#mailboxId();
		if (!mailboxId) return;
		const index = durableObjectInternals(this.env).index();
		for (let batch = 0; batch < PUSH_BATCHES_PER_FLUSH; batch++) {
			const { rows, seq } = readOutbox(this.exec);
			if (rows.length === 0) return;
			await index.applyBatch(mailboxId, rows);
			ackOutbox(this.exec, rows.map((row) => row.email_id), seq);
		}
		// More than 50 batches pending: continue from an alarm instead of holding the caller.
		await this.#armAlarm(Date.now() + 1_000);
	}

	async #scheduleRetry(): Promise<void> {
		const previous = Number(getMeta(this.exec, "retry_ms") || 0);
		const delay = Math.min(Math.max(previous * 2, RETRY_MIN_MS), RETRY_MAX_MS);
		setMeta(this.exec, "retry_ms", String(delay));
		await this.#armAlarm(Date.now() + delay);
	}

	/**
	 * The one alarm serves index retries and scheduled sends. Only ever move it
	 * earlier; alarm() runs both jobs and re-arms for whatever is still pending.
	 */
	async #armAlarm(at: number): Promise<void> {
		const current = await this.ctx.storage.getAlarm();
		if (current === null || current > at) await this.ctx.storage.setAlarm(at);
	}

	async alarm() {
		await this.flushIndex();
		await this.#sendDueScheduled();
		const next = nextScheduledAt(this.exec);
		if (next !== null) await this.#armAlarm(next);
	}

	// ── Scheduled send ─────────────────────────────────────────────
	//
	// The message waits as a draft in Drafts; scheduled_sends holds the send
	// request. Editing or deleting the draft cancels the send.

	/**
	 * Save the message as a new draft and schedule it. The route validates
	 * sendAt, the sender and the payload size. Replaces draftId if it is a draft.
	 */
	async scheduleSend(input: {
		/** The route's mailbox; teaches the mailbox its address so the alarm can send. */
		mailboxId?: string;
		sendAt: string;
		draftId?: string;
		mode: ScheduleMode;
		originalId?: string;
		email: SendEmailRequest;
	}): Promise<{ id: string; sendAt: string } | { error: string; status: 404 }> {
		if (input.mailboxId && !getMeta(this.exec, "mailbox_id")) setMeta(this.exec, "mailbox_id", input.mailboxId.toLowerCase());
		const mailboxId = this.#mailboxId() ?? "";
		const { email, mode, originalId } = input;
		let threadId: string | null = null;
		if (originalId && mode !== "new") {
			const raw = await this.getEmail(originalId);
			if (!raw) return { error: "Original email not found", status: 404 };
			const original = raw.folder_id === Folders.DRAFT && raw.in_reply_to
				? (await this.getEmail(raw.in_reply_to)) ?? raw
				: raw;
			if (mode !== "forward") threadId = original.thread_id || original.id;
		}
		const join = (v?: string | string[]) => (v ? (Array.isArray(v) ? v.join(", ") : v).toLowerCase() : null);
		const id = crypto.randomUUID();
		const sendAt = new Date(input.sendAt).toISOString();
		await this.createEmail(Folders.DRAFT, {
			id, subject: email.subject || "", sender: mailboxId.toLowerCase(),
			recipient: join(email.to) ?? "", cc: join(email.cc), bcc: join(email.bcc),
			date: new Date().toISOString(), body: email.html || email.text || "",
			in_reply_to: originalId || null, email_references: null,
			thread_id: threadId || originalId || id,
		}, []);
		insertScheduled(this.exec, id, sendAt, { mode, original_id: originalId, email });
		if (input.draftId && input.draftId !== id) {
			const old = await this.getEmail(input.draftId);
			if (old?.folder_id === Folders.DRAFT) {
				deleteScheduledRow(this.exec, input.draftId);
				await this.deleteEmail(input.draftId);
			}
		}
		await this.#armAlarm(Date.parse(sendAt));
		return { id, sendAt };
	}

	async listScheduled() {
		return listScheduledRows(this.exec);
	}

	/** Drop the schedule only; the draft stays in Drafts. */
	async cancelScheduled(emailId: string): Promise<boolean> {
		return deleteScheduledRow(this.exec, emailId);
	}

	// ── Send idempotency keys ──────────────────────────────────────

	async claimSendKey(key: string): Promise<SendKeyClaim> {
		return claimSendKey(this.exec, key);
	}

	async finishSendKey(key: string, emailId: string): Promise<void> {
		finishSendKey(this.exec, key, emailId);
	}

	async releaseSendKey(key: string): Promise<void> {
		releaseSendKey(this.exec, key);
	}

	async #sendDueScheduled() {
		const mailboxId = this.#mailboxId();
		try {
			const result = await runDueScheduled({
				exec: this.exec,
				draftFolder: async (emailId) => (await this.getEmail(emailId))?.folder_id ?? null,
				deleteDraft: (emailId) => this.deleteEmail(emailId),
				send: async (payload, emailId) => {
					if (!mailboxId) return "Mailbox address unknown";
					const sent = await sendMail(this.env, mailboxId, this, payload.email, sendModeOf(payload), {
						idempotencyKey: `draft:${emailId}`,
					});
					return sent.ok ? null : sent.error;
				},
			}, Folders.DRAFT);
			if (result.failed.length > 0) console.error(`scheduled send failed for ${result.failed.length} message(s)`);
		} catch (e) {
			console.error("scheduled send run failed:", (e as Error).message);
		}
	}

	/** One rebuild page for MailIndexDO. Also teaches the mailbox its address. */
	async exportIndexRows(options: { mailboxId: string; afterId?: string | null; limit?: number }) {
		const id = options.mailboxId.toLowerCase();
		if (getMeta(this.exec, "mailbox_id") !== id) setMeta(this.exec, "mailbox_id", id);
		return exportIndexRows(this.exec, options);
	}

	/** Source-of-truth counts for the parity page. */
	async indexStatus() {
		return {
			mailboxId: this.#mailboxId(),
			seq: currentSeq(this.exec),
			pending: pendingCount(this.exec),
			counts: mailboxCounts(this.exec),
			inboxConversations: await this.countThreadedEmails(Folders.INBOX),
		};
	}

	// ── Email CRUD (Drizzle) ───────────────────────────────────────

	async getEmails(options: GetEmailsOptions = {}) {
		const {
			folder,
			thread_id,
			page = 1,
			limit: rawLimit = 25,
			sortColumn: rawSortColumn = "date",
			sortDirection = "DESC",
		} = options;

		// Cap pagination limit to prevent unbounded queries
		const limit = Math.min(Math.max(rawLimit, 1), 100);

		const sortColumn: SortColumn = ALLOWED_SORT_COLUMNS.includes(
			rawSortColumn as SortColumn,
		)
			? rawSortColumn
			: "date";

		const offset = (page - 1) * limit;

		const conditions: SQL[] = [];
		if (folder) {
			conditions.push(
				sql`${schema.emails.folder_id} = (SELECT id FROM folders WHERE name = ${folder} OR id = ${folder} LIMIT 1)`,
			);
		}
		if (thread_id) {
			conditions.push(eq(schema.emails.thread_id, thread_id));
		}

		const orderCol = SORT_COLUMN_MAP[sortColumn];
		const orderDir = sortDirection === "ASC" ? asc(orderCol) : desc(orderCol);

		const result = this.db
			.select({
				id: schema.emails.id,
				subject: schema.emails.subject,
				sender: schema.emails.sender,
				recipient: schema.emails.recipient,
				cc: schema.emails.cc,
				bcc: schema.emails.bcc,
				date: schema.emails.date,
				read: schema.emails.read,
				starred: schema.emails.starred,
				in_reply_to: schema.emails.in_reply_to,
				email_references: schema.emails.email_references,
				thread_id: schema.emails.thread_id,
				folder_id: schema.emails.folder_id,
				snippet: sql<string>`SUBSTR(${schema.emails.body}, 1, 300)`,
			})
			.from(schema.emails)
			.where(conditions.length > 0 ? and(...conditions) : undefined)
			.orderBy(orderDir)
			.limit(limit)
			.offset(offset)
			.all();

		return result.map((email) => ({
			...email,
			read: !!email.read,
			starred: !!email.starred,
		}));
	}

	/**
	 * Count total emails matching the given filters (for pagination).
	 */
	async countEmails(options: { folder?: string; thread_id?: string } = {}) {
		const { folder, thread_id } = options;
		const conditions: string[] = [];
		const params: (string | number)[] = [];

		if (folder) {
			conditions.push(
				"folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)",
			);
			params.push(folder);
		}

		if (thread_id) {
			conditions.push(`thread_id = ?${params.length + 1}`);
			params.push(thread_id);
		}

		const where =
			conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const row = [
			...this.ctx.storage.sql.exec(
				`SELECT COUNT(*) as total FROM emails ${where}`,
				...params,
			),
		][0] as { total: number } | undefined;

		return row?.total ?? 0;
	}

	// ── Threaded queries (raw SQL — too complex for Drizzle's builder) ──

	async getThreadedEmails(options: GetEmailsOptions = {}) {
		const {
			folder,
			page = 1,
			offset: requestedOffset,
			limit: rawLimit = 25,
		} = options;
		const limit = Math.min(Math.max(rawLimit, 1), 100);

		if (!folder) {
			// Fallback to regular getEmails if no folder specified
			return this.getEmails(options);
		}

		const offset = requestedOffset ?? (page - 1) * limit;

		// Thread grouping strategy:
		// For DRAFT folder: group by in_reply_to (the email being replied to).
		//   This ensures reply-drafts to different emails stay separate, even if
		//   they share a thread_id or subject. New drafts (no in_reply_to) each
		//   get their own group via their unique id.
		// For other folders:
		//   1. Primary: group by thread_id (from email threading headers)
		//   2. Fallback: group by normalized subject (strips Re:/Fwd:/FW: prefixes)
		//      for legacy emails that lack threading headers (thread_id IS NULL).
		const isDraftFolder = folder === Folders.DRAFT;

		if (isDraftFolder) {
			const result = this.ctx.storage.sql.exec(
				`WITH
				folder_emails AS (
					SELECT *,
						COALESCE(in_reply_to, id) as draft_group_key
					FROM emails
					WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
				),
				draft_stats AS (
					SELECT
						draft_group_key,
						COUNT(*) as thread_count,
						SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) as thread_unread_count,
						GROUP_CONCAT(DISTINCT sender) as participants
					FROM folder_emails
					GROUP BY draft_group_key
				),
				latest_per_group AS (
					SELECT
						fe.*,
						ROW_NUMBER() OVER (
							PARTITION BY fe.draft_group_key
							ORDER BY fe.date DESC
						) as rn
					FROM folder_emails fe
				)
				SELECT
					lp.id, lp.subject, lp.sender, lp.recipient, lp.date,
					lp.read, lp.starred, lp.thread_id, lp.folder_id,
					lp.in_reply_to, lp.email_references,
					SUBSTR(lp.body, 1, 300) as snippet,
					ds.thread_count, ds.thread_unread_count, ds.participants
				FROM latest_per_group lp
				JOIN draft_stats ds ON lp.draft_group_key = ds.draft_group_key
				WHERE lp.rn = 1
				ORDER BY lp.date DESC
				LIMIT ?2 OFFSET ?3`,
				folder, limit, offset
			);

			const rows = [...result];
			return rows.map((row: any) => ({
				...row,
				read: !!row.read,
				starred: !!row.starred,
				thread_count: row.thread_count || 1,
				thread_unread_count: row.thread_unread_count || 0,
				participants: row.participants || row.sender,
			}));
		}

		// Non-draft folders: full threading logic
		const result = this.ctx.storage.sql.exec(
			`WITH
			folder_emails AS (
				SELECT *,
					COALESCE(thread_id, id) as raw_thread_id,
					${NORMALIZED_SUBJECT_SQL} as normalized_subject
				FROM emails
				WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
			),
			thread_to_conversation AS (
				SELECT
					raw_thread_id,
					normalized_subject,
					CASE
						WHEN thread_id IS NOT NULL THEN raw_thread_id
						ELSE MIN(raw_thread_id) OVER (PARTITION BY normalized_subject)
					END as conversation_id
				FROM folder_emails
				GROUP BY raw_thread_id, normalized_subject, thread_id
			),
			all_emails_with_conversation AS (
				SELECT
					e.*,
					COALESCE(tc.conversation_id, COALESCE(e.thread_id, e.id)) as conversation_id
				FROM emails e
				LEFT JOIN thread_to_conversation tc
					ON COALESCE(e.thread_id, e.id) = tc.raw_thread_id
			),
			conversation_stats AS (
				SELECT
					conversation_id,
					COUNT(*) as thread_count,
					SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) as thread_unread_count,
					SUM(CASE WHEN read = 1 THEN 1 ELSE 0 END) as thread_read_count,
					GROUP_CONCAT(DISTINCT sender) as participants,
					SUM(CASE WHEN folder_id = (SELECT id FROM folders WHERE name = 'draft' LIMIT 1) THEN 1 ELSE 0 END) as has_draft
				FROM all_emails_with_conversation
				WHERE conversation_id IN (
					SELECT DISTINCT conversation_id FROM all_emails_with_conversation
					WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
				)
				GROUP BY conversation_id
			),
			latest_message_per_conversation AS (
				SELECT
					conversation_id,
					folder_id,
					ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY date DESC) as rn
				FROM all_emails_with_conversation
			),
			latest_in_folder AS (
				SELECT
					fe.*,
					COALESCE(tc.conversation_id, fe.raw_thread_id) as conversation_id,
					ROW_NUMBER() OVER (
						PARTITION BY COALESCE(tc.conversation_id, fe.raw_thread_id)
						ORDER BY fe.date DESC
					) as rn
				FROM folder_emails fe
				LEFT JOIN thread_to_conversation tc
					ON fe.raw_thread_id = tc.raw_thread_id
			)
			SELECT
				lif.id, lif.subject, lif.sender, lif.recipient, lif.date,
				lif.read, lif.starred, lif.thread_id, lif.folder_id,
				lif.in_reply_to, lif.email_references,
				SUBSTR(lif.body, 1, 300) as snippet,
				cs.thread_count, cs.thread_unread_count, cs.participants,
				CASE WHEN lmc.folder_id != (SELECT id FROM folders WHERE name = 'sent' LIMIT 1)
					AND lmc.folder_id != (SELECT id FROM folders WHERE name = 'draft' LIMIT 1)
					AND cs.thread_read_count > 0
					THEN 1 ELSE 0 END as needs_reply,
				CASE WHEN cs.has_draft > 0 THEN 1 ELSE 0 END as has_draft
			FROM latest_in_folder lif
			JOIN conversation_stats cs ON lif.conversation_id = cs.conversation_id
			LEFT JOIN latest_message_per_conversation lmc
				ON lmc.conversation_id = lif.conversation_id AND lmc.rn = 1
			WHERE lif.rn = 1
			ORDER BY lif.date DESC
			LIMIT ?2 OFFSET ?3`,
			folder, limit, offset
		);

		const rows = [...result];
		return rows.map((row: any) => ({
			...row,
			read: !!row.read,
			starred: !!row.starred,
			thread_count: row.thread_count || 1,
			thread_unread_count: row.thread_unread_count || 0,
			participants: row.participants || row.sender,
			needs_reply: !!row.needs_reply,
			has_draft: !!row.has_draft,
		}));
	}

	/**
	 * Count threaded conversations in a folder (for pagination).
	 * Returns the number of conversation groups, not individual emails.
	 */
	async countThreadedEmails(folder: string) {
		const isDraftFolder = folder === Folders.DRAFT;

		if (isDraftFolder) {
			const row = [
				...this.ctx.storage.sql.exec(
					`SELECT COUNT(DISTINCT COALESCE(in_reply_to, id)) as total
					 FROM emails
					 WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)`,
					folder,
				),
			][0] as { total: number } | undefined;
			return row?.total ?? 0;
		}

		const row = [
			...this.ctx.storage.sql.exec(
				`WITH
				folder_emails AS (
					SELECT
						COALESCE(thread_id, id) as raw_thread_id,
						thread_id,
					${NORMALIZED_SUBJECT_SQL} as normalized_subject
					FROM emails
					WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
				),
				thread_to_conversation AS (
					SELECT
						raw_thread_id,
						CASE
							WHEN thread_id IS NOT NULL THEN raw_thread_id
							WHEN normalized_subject != '' THEN MIN(raw_thread_id) OVER (PARTITION BY normalized_subject)
							ELSE raw_thread_id
						END as conversation_id
					FROM folder_emails
					GROUP BY raw_thread_id, normalized_subject, thread_id
				)
				SELECT COUNT(DISTINCT conversation_id) as total
				FROM thread_to_conversation`,
				folder,
			),
		][0] as { total: number } | undefined;
		return row?.total ?? 0;
	}

	// ── Single email operations (Drizzle) ──────────────────────────

	async getEmail(id: string) {
		const email = this.db
			.select()
			.from(schema.emails)
			.where(eq(schema.emails.id, id))
			.get();

		if (!email) return null;

		const emailAttachments = this.db
			.select()
			.from(schema.attachments)
			.where(eq(schema.attachments.email_id, id))
			.all();

		return {
			...email,
			read: !!email.read,
			starred: !!email.starred,
			attachments: emailAttachments,
		};
	}

	/**
	 * Fetch all emails in a thread with full bodies and attachments in
	 * two queries (one for emails, one for attachments) instead of
	 * N+1 individual getEmail calls.
	 */
	async getThreadEmails(threadId: string) {
		const emailRows = [
			...this.ctx.storage.sql.exec(
				`SELECT * FROM emails WHERE thread_id = ?1 ORDER BY date ASC`,
				threadId,
			),
		] as any[];

		if (emailRows.length === 0) return [];

		const emailIds = emailRows.map((e) => e.id as string);

		// Batch-fetch all attachments for the thread in a single query
		const placeholders = emailIds.map((_, i) => `?${i + 1}`).join(",");
		const attachmentRows = [
			...this.ctx.storage.sql.exec(
				`SELECT * FROM attachments WHERE email_id IN (${placeholders})`,
				...emailIds,
			),
		] as any[];

		// Group attachments by email_id
		const attachmentsByEmail = new Map<string, any[]>();
		for (const att of attachmentRows) {
			const list = attachmentsByEmail.get(att.email_id) || [];
			list.push(att);
			attachmentsByEmail.set(att.email_id, list);
		}

		return emailRows.map((email) => ({
			...email,
			read: !!email.read,
			starred: !!email.starred,
			attachments: attachmentsByEmail.get(email.id) || [],
		}));
	}

	async updateEmail(
		id: string,
		{ read, starred }: { read?: boolean; starred?: boolean },
	) {
		const data: { read?: number; starred?: number } = {};
		if (read !== undefined) {
			data.read = read ? 1 : 0;
		}
		if (starred !== undefined) {
			data.starred = starred ? 1 : 0;
		}

		if (Object.keys(data).length === 0) {
			return this.getEmail(id);
		}

		await this.#change(() => {
			const changed = this.db
				.update(schema.emails)
				.set(data)
				.where(eq(schema.emails.id, id))
				.returning({ id: schema.emails.id })
				.all();
			return { result: undefined, ids: changed.map((row) => row.id) };
		});

		return this.getEmail(id);
	}

	async markThreadRead(threadId: string) {
		const ids = await this.#change(() => {
			const changed = this.exec(
				`UPDATE emails SET read = 1 WHERE thread_id = ? AND read = 0 RETURNING id`,
				threadId,
			).map((row) => String(row.id));
			return { result: changed, ids: changed };
		});
		return { threadId, markedRead: true, ids };
	}

	/**
	 * Permanently delete an email. Only mail in Trash or Drafts can be deleted;
	 * use trashOrDelete for a user-facing Delete.
	 */
	async deleteEmail(id: string) {
		return this.#change(() => {
			const email = this.db
				.select({ id: schema.emails.id, folder_id: schema.emails.folder_id })
				.from(schema.emails)
				.where(eq(schema.emails.id, id))
				.get();

			if (!email) return { result: null, ids: [] };
			if (!HARD_DELETE_FOLDERS.includes(email.folder_id)) {
				throw new Error("Only mail in Trash or Drafts can be deleted");
			}

			const emailAttachments = this.db
				.select({
					id: schema.attachments.id,
					filename: schema.attachments.filename,
				})
				.from(schema.attachments)
				.where(eq(schema.attachments.email_id, id))
				.all();

			this.db
				.delete(schema.emails)
				.where(eq(schema.emails.id, id))
				.run();

			return { result: emailAttachments, ids: [id] };
		});
	}

	/**
	 * Delete as the user sees it: mail outside Trash and Drafts moves to Trash;
	 * mail already in Trash, and drafts, are deleted permanently.
	 * Returns null when the email does not exist.
	 */
	async trashOrDelete(id: string): Promise<
		| { action: "trashed"; attachments: [] }
		| { action: "deleted"; attachments: { id: string; filename: string }[] }
		| null
	> {
		const email = this.db
			.select({ folder_id: schema.emails.folder_id })
			.from(schema.emails)
			.where(eq(schema.emails.id, id))
			.get();
		if (!email) return null;
		if (HARD_DELETE_FOLDERS.includes(email.folder_id)) {
			const attachments = await this.deleteEmail(id);
			return attachments === null ? null : { action: "deleted", attachments };
		}
		await this.moveEmail(id, Folders.TRASH);
		return { action: "trashed", attachments: [] };
	}

	async getAttachment(id: string) {
		return (
			this.db
				.select()
				.from(schema.attachments)
				.where(eq(schema.attachments.id, id))
				.get() ?? null
		);
	}

	// ── Folders (Drizzle) ──────────────────────────────────────────

	async getFolders() {
		const result = this.db
			.select({
				id: schema.folders.id,
				name: schema.folders.name,
				unreadCount: sql<number>`COALESCE(SUM(CASE WHEN ${schema.emails.read} = 0 THEN 1 ELSE 0 END), 0)`.mapWith(Number),
			})
			.from(schema.folders)
			.leftJoin(schema.emails, eq(schema.emails.folder_id, schema.folders.id))
			.groupBy(schema.folders.id, schema.folders.name)
			.all();
		// After the folder import, custom folders are labels: nothing moves into them.
		const imported = foldersImported(this.exec);
		return result.map((f) => ({ ...f, can_move_to: !imported || isSystemFolder(f.id) }));
	}

	async createFolder(id: string, name: string, is_deletable: number = 1) {
		try {
			const result = this.db
				.insert(schema.folders)
				.values({ id, name, is_deletable })
				.returning({ id: schema.folders.id, name: schema.folders.name })
				.get();
			return { ...result, unreadCount: 0 };
		} catch (e: unknown) {
			if (e instanceof Error && e.message.includes("UNIQUE constraint failed")) {
				return null;
			}
			throw e;
		}
	}

	async updateFolder(id: string, name: string) {
		const result = this.db
			.update(schema.folders)
			.set({ name })
			.where(eq(schema.folders.id, id))
			.returning({ id: schema.folders.id, name: schema.folders.name })
			.get();
		return result;
	}

	/**
	 * Delete an empty custom folder. A folder that still holds mail is refused,
	 * because the folder's foreign key would cascade to its emails.
	 */
	async deleteFolder(id: string): Promise<"deleted" | "not_found" | "not_empty"> {
		const folder = this.db
			.select({ is_deletable: schema.folders.is_deletable })
			.from(schema.folders)
			.where(eq(schema.folders.id, id))
			.get();

		if (!folder || folder.is_deletable === 0) {
			return "not_found";
		}

		const holdsMail = this.db
			.select({ id: schema.emails.id })
			.from(schema.emails)
			.where(eq(schema.emails.folder_id, id))
			.limit(1)
			.get();
		if (holdsMail) return "not_empty";

		this.db
			.delete(schema.folders)
			.where(eq(schema.folders.id, id))
			.run();

		return "deleted";
	}

	async moveEmail(id: string, folderId: string) {
		const folder = this.db
			.select({ id: schema.folders.id })
			.from(schema.folders)
			.where(eq(schema.folders.id, folderId))
			.get();

		if (!folder) return false;
		if (!isSystemFolder(folderId) && foldersImported(this.exec)) return false;

		await this.#change(() => {
			const changed = this.db
				.update(schema.emails)
				.set({ folder_id: folderId })
				.where(eq(schema.emails.id, id))
				.returning({ id: schema.emails.id })
				.all();
			return { result: undefined, ids: changed.map((row) => row.id) };
		});

		return true;
	}

	// ── Bulk actions and labels ────────────────────────────────────
	//
	// Called by MailIndexDO with at most 100 ids. Each records its changes in
	// the outbox and pushes before returning.

	async updateEmails(ids: string[], patch: { read?: boolean; starred?: boolean }) {
		const changed = await this.#change(() => {
			const out = updateEmailsSql(this.exec, ids, patch);
			return { result: out, ids: out };
		});
		return { changed };
	}

	async moveEmails(ids: string[], to: string, from?: string) {
		const changed = await this.#change(() => {
			const out = moveEmailsSql(this.exec, ids, to, from);
			return { result: out, ids: out };
		});
		return { changed };
	}

	async setLabels(ids: string[], change: { add?: string[]; remove?: string[] }) {
		const changed = await this.#change(() => {
			const out = setLabelsSql(this.exec, ids, change);
			return { result: out, ids: out };
		});
		return { changed };
	}

	/** Empty Trash: permanently delete these emails if they are still in Trash. */
	async purgeTrash(ids: string[]) {
		return this.#change(() => {
			const out = purgeTrashSql(this.exec, ids);
			return { result: { changed: out.deleted, attachments: out.attachments }, ids: out.deleted };
		});
	}

	// ── Folder import ──────────────────────────────────────────────

	async folderImportCounts() {
		return { folders: customFolderCounts(this.exec), imported: foldersImported(this.exec) };
	}

	async folderEmailIds(folderId: string) {
		return folderEmailIdsSql(this.exec, folderId);
	}

	/**
	 * Convert one custom folder: label its mail and push (the index acknowledges
	 * the push before this continues), then move labeled mail still in the
	 * folder to Archive. The folder is never deleted. Safe to run again.
	 */
	async importFolder(folderId: string, labelId: string) {
		if (isSystemFolder(folderId)) throw new Error("System folders are not imported");
		const labeled = await this.#change(() => {
			const out = importFolderLabelSql(this.exec, folderId, labelId);
			return { result: out, ids: out };
		});
		const archived = await this.#change(() => {
			const out = importFolderArchiveSql(this.exec, folderId, labelId);
			return { result: out, ids: out };
		});
		return { labeled: labeled.length, archived: archived.length };
	}

	/** After every folder of this mailbox is converted, moves go to system folders only. */
	async markFoldersImported() {
		setMeta(this.exec, "folders_imported", "1");
		return { imported: true };
	}

	// ── Search (raw SQL — dynamic condition builder) ───────────────

	/**
	 * Build WHERE conditions and params for search queries.
	 * Shared between searchEmails and countSearchResults.
	 */
	#buildSearchConditions(
		options: SearchFilterOptions,
		tableAlias = "",
	): { conditions: string[]; params: (string | number)[] } {
		const { query, folder, from, to, subject, date_start, date_end, is_read, is_starred, has_attachment } = options;
		const prefix = tableAlias ? `${tableAlias}.` : "";
		const conditions: string[] = [];
		const params: (string | number)[] = [];
		let paramIdx = 0;

		const addParam = (value: string | number) => {
			paramIdx++;
			params.push(value);
			return `?${paramIdx}`;
		};

		if (query) {
			const p1 = addParam(`%${query}%`);
			const p2 = addParam(`%${query}%`);
			const p3 = addParam(`%${query}%`);
			const p4 = addParam(`%${query}%`);
			conditions.push(`(${prefix}subject LIKE ${p1} OR ${prefix}body LIKE ${p2} OR ${prefix}sender LIKE ${p3} OR ${prefix}recipient LIKE ${p4} OR ${prefix}cc LIKE ${p4} OR ${prefix}bcc LIKE ${p4})`);
		}
		if (folder) {
			const p = addParam(folder);
			conditions.push(`${prefix}folder_id = (SELECT id FROM folders WHERE name = ${p} OR id = ${p} LIMIT 1)`);
		}
		if (from) { const p = addParam(`%${from}%`); conditions.push(`${prefix}sender LIKE ${p}`); }
		if (to) { const p = addParam(`%${to}%`); conditions.push(`(${prefix}recipient LIKE ${p} OR ${prefix}cc LIKE ${p} OR ${prefix}bcc LIKE ${p})`); }
		if (subject) { const p = addParam(`%${subject}%`); conditions.push(`${prefix}subject LIKE ${p}`); }
		if (date_start) { const p = addParam(date_start); conditions.push(`${prefix}date >= ${p}`); }
		if (date_end) { const p = addParam(date_end); conditions.push(`${prefix}date <= ${p}`); }
		if (is_read !== undefined) { const p = addParam(is_read ? 1 : 0); conditions.push(`${prefix}read = ${p}`); }
		if (is_starred !== undefined) { const p = addParam(is_starred ? 1 : 0); conditions.push(`${prefix}starred = ${p}`); }
		if (has_attachment) { conditions.push(`${prefix}id IN (SELECT DISTINCT email_id FROM attachments)`); }

		return { conditions, params };
	}

	async searchEmails(options: SearchFilterOptions & { page?: number; limit?: number }) {
		const { page = 1, limit: rawLimit = 25 } = options;
		const limit = Math.min(Math.max(rawLimit, 1), 100);
		const { conditions, params } = this.#buildSearchConditions(options, "e");

		const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const offset = (page - 1) * limit;

		const query = `
			SELECT e.id, e.subject, e.sender, e.recipient, e.cc, e.bcc, e.date,
				e.read, e.starred, e.in_reply_to, e.email_references,
				e.thread_id, e.folder_id,
				SUBSTR(e.body, 1, 300) as snippet,
				f.name as folder_name
			FROM emails e
			LEFT JOIN folders f ON e.folder_id = f.id
			${where}
			ORDER BY e.date DESC LIMIT ?${params.length + 1} OFFSET ?${params.length + 2}`;
		params.push(limit, offset);

		const result = this.ctx.storage.sql.exec(query, ...params);
		return [...result].map((row: any) => ({
			...row,
			read: !!row.read,
			starred: !!row.starred,
		}));
	}

	/**
	 * Count total search results matching the given filters (for pagination).
	 */
	async countSearchResults(options: SearchFilterOptions) {
		const { conditions, params } = this.#buildSearchConditions(options);

		const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const query = `SELECT COUNT(*) as total FROM emails ${where}`;

		const row = [...this.ctx.storage.sql.exec(query, ...params)][0] as
			| { total: number }
			| undefined;
		return row?.total ?? 0;
	}

	// ── Threading helpers (raw SQL) ────────────────────────────────

	async findThreadBySubject(subject: string, senderAddress?: string): Promise<string | null> {
		const normalized = subject
			.replace(/^(?:(?:re|fwd?|fw|aw|wg|r[eé]f|sv)\s*:\s*)+/i, "")
			.trim()
			.toLowerCase();

		if (!normalized) return null;

		const result = this.ctx.storage.sql.exec(
			`SELECT thread_id, subject,
			        GROUP_CONCAT(DISTINCT LOWER(sender)) as senders,
			        GROUP_CONCAT(DISTINCT LOWER(recipient)) as recipients
			 FROM emails
			 WHERE thread_id IS NOT NULL
			   AND thread_id != id
			   AND date >= datetime('now', '-7 days')
			 GROUP BY thread_id
			 ORDER BY MAX(date) DESC
			 LIMIT 50`,
		);

		const normalizedSender = senderAddress?.toLowerCase().trim();

		for (const row of result) {
			const rowSubject = String((row as any).subject || "")
				.replace(/^(?:(?:re|fwd?|fw|aw|wg|r[eé]f|sv)\s*:\s*)+/i, "")
				.trim()
				.toLowerCase();
			if (rowSubject !== normalized) continue;

			if (normalizedSender) {
				const threadSenders = String((row as any).senders || "");
				const threadRecipients = String((row as any).recipients || "");
				const allParticipants = `${threadSenders},${threadRecipients}`;
				if (!allParticipants.includes(normalizedSender)) {
					continue;
				}
			}

			return String((row as any).thread_id);
		}
		return null;
	}

	// ── Rate limiting (raw SQL) ────────────────────────────────────

	/**
	 * Check if the mailbox has exceeded the send rate limit.
	 * Limits: 20 emails per hour, 100 per day per mailbox.
	 * Returns null if under limit, or an error message string if exceeded.
	 */
	async checkSendRateLimit(): Promise<string | null> {
		const hourRow = [...this.ctx.storage.sql.exec(
			`SELECT COUNT(*) as cnt FROM emails
			 WHERE folder_id = ?1
			   AND date >= datetime('now', '-1 hour')`,
			Folders.SENT,
		)][0] as { cnt: number } | undefined;

		if ((hourRow?.cnt ?? 0) >= 20) {
			return "Rate limit exceeded: max 20 emails per hour per mailbox";
		}

		const dayRow = [...this.ctx.storage.sql.exec(
			`SELECT COUNT(*) as cnt FROM emails
			 WHERE folder_id = ?1
			   AND date >= datetime('now', '-1 day')`,
			Folders.SENT,
		)][0] as { cnt: number } | undefined;

		if ((dayRow?.cnt ?? 0) >= 100) {
			return "Rate limit exceeded: max 100 emails per day per mailbox";
		}

		return null;
	}

	// ── Email creation (Drizzle) ───────────────────────────────────

	async createEmail(
		folder: string,
		email: EmailData,
		attachments: AttachmentData[],
	) {
		// Resolve folder name or ID to the actual folder ID.
		const folderRow = this.db
			.select({ id: schema.folders.id })
			.from(schema.folders)
			.where(or(eq(schema.folders.id, folder), eq(schema.folders.name, folder)))
			.limit(1)
			.get();

		if (!folderRow) {
			throw new Error(
				`createEmail: folder "${folder}" not found. ` +
					"Ensure the folder exists before inserting an email.",
			);
		}

		const folderId = folderRow.id;
		const isSent = folderId === Folders.SENT;

		// Sent emails are always read — the sender obviously knows what they wrote.
		// This prevents sent replies from inflating thread_unread_count.
		await this.#change(() => {
			this.db
				.insert(schema.emails)
				.values({
					id: email.id,
					folder_id: folderId,
					subject: email.subject,
					sender: email.sender,
					recipient: email.recipient,
					cc: email.cc ?? null,
					bcc: email.bcc ?? null,
					date: email.date,
					read: isSent ? 1 : (email.read ? 1 : 0),
					starred: email.starred ? 1 : 0,
					body: email.body,
					in_reply_to: email.in_reply_to ?? null,
					email_references: email.email_references ?? null,
					thread_id: email.thread_id ?? null,
					message_id: email.message_id ?? null,
					raw_headers: email.raw_headers ?? null,
				})
				.run();

			if (attachments.length > 0) {
				this.db.insert(schema.attachments).values(attachments).run();
			}
			return { result: undefined, ids: [email.id] };
		});
	}
}
