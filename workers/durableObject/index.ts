// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { DurableObject } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { eq, and, or, asc, desc, sql, notInArray } from "drizzle-orm";
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
import { durableObjectInternals, usesD1 } from "../store";
import {
	ackCopyChanges,
	copyCounts,
	copyMeta,
	copyPage,
	copyRows,
	copyTracking,
	pendingCopyChanges,
	readCopyChanges,
	startCopyTracking,
	stopCopyTracking,
} from "../lib/copy-rows";
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
import { deleteAttachmentFiles } from "../lib/attachments";
import {
	MAX_REFERENCED_IDS,
	SUBJECT_JOIN_WINDOW_MS,
	type SubjectRow,
	hasReplyPrefix,
	normalizeThreadSubject,
	pickReferencedThread,
	pickSubjectThread,
} from "../lib/threading";

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
		// On D1 the schedules live there; re-arming for rows left here would loop.
		const next = usesD1(this.env) ? null : nextScheduledAt(this.exec);
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
				const attachments = await this.deleteEmail(input.draftId);
				if (attachments) await deleteAttachmentFiles(this.env.BUCKET, input.draftId, attachments);
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
		// On D1 the cron sends scheduled mail from the copy; sending here too would send twice.
		if (usesD1(this.env)) return;
		const mailboxId = this.#mailboxId();
		try {
			const result = await runDueScheduled({
				exec: this.exec,
				draftFolder: async (emailId) => (await this.getEmail(emailId))?.folder_id ?? null,
				deleteDraft: async (emailId) => {
					const attachments = await this.deleteEmail(emailId);
					if (attachments) await deleteAttachmentFiles(this.env.BUCKET, emailId, attachments);
				},
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

	// ── Copy to D1 ─────────────────────────────────────────────────
	//
	// Read side of the one-time copy (store/copy-job.ts, lib/copy-rows.ts).

	/** Start recording changes for the copy. Also teaches the mailbox its address. */
	async copyStart(mailboxId: string) {
		const id = mailboxId.toLowerCase();
		if (getMeta(this.exec, "mailbox_id") !== id) setMeta(this.exec, "mailbox_id", id);
		return startCopyTracking(this.exec);
	}

	async copyPage(afterId: string | null, limit?: number) {
		return copyPage(this.exec, afterId, limit);
	}

	/** The next changed ids with their current rows, and the seq to ack them with. */
	async copyChanges(limit?: number) {
		const { ids, seq } = readCopyChanges(this.exec, limit);
		return { ...copyRows(this.exec, ids), ids, seq };
	}

	/** Full rows for these ids; the ones that no longer exist are in `missing`. */
	async copyRows(ids: string[]) {
		return copyRows(this.exec, ids);
	}

	async copyAck(ids: string[], seq: number) {
		ackCopyChanges(this.exec, ids, seq);
	}

	async copyMeta() {
		return copyMeta(this.exec);
	}

	async copyStatus() {
		return { tracking: copyTracking(this.exec), pending: pendingCopyChanges(this.exec), counts: copyCounts(this.exec) };
	}

	/** After the last pass: stop tracking, and drop the schedules D1 now sends. The drafts stay. */
	async copyStop() {
		stopCopyTracking(this.exec);
		this.exec(`DELETE FROM scheduled_sends`);
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

	// ── Threaded count (raw SQL) ───────────────────────────────────

	/**
	 * Count conversations in a folder, for the index status page.
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

	async hasInboundMessageId(messageId: string): Promise<boolean> {
		return !!this.db
			.select({ id: schema.emails.id })
			.from(schema.emails)
			.where(and(
				eq(schema.emails.message_id, messageId),
				notInArray(schema.emails.folder_id, [Folders.SENT, Folders.DRAFT]),
			))
			.limit(1)
			.get();
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

	// ── Threading helpers (raw SQL) ────────────────────────────────

	/** The thread of the nearest message in this mailbox whose Message-ID is one of `ids` (workers/lib/threading.ts). */
	async findThreadByMessageIds(ids: string[]): Promise<string | null> {
		const wanted = ids.slice(0, MAX_REFERENCED_IDS);
		if (wanted.length === 0) return null;
		const rows = this.ctx.storage.sql.exec(
			`SELECT message_id, thread_id FROM emails
			 WHERE thread_id IS NOT NULL AND message_id IN (${wanted.map(() => "?").join(", ")})`,
			...wanted,
		).toArray();
		return pickReferencedThread(wanted, rows);
	}

	/** A recent thread a header-less reply belongs to (workers/lib/threading.ts). */
	async findThreadBySubject(subject: string, senderAddress?: string): Promise<string | null> {
		if (!hasReplyPrefix(subject) || !normalizeThreadSubject(subject) || !senderAddress) return null;
		const rows = this.ctx.storage.sql.exec(
			`SELECT thread_id, subject, LOWER(sender) AS sender, LOWER(recipient) AS recipient, folder_id, date
			 FROM emails
			 WHERE thread_id IS NOT NULL AND folder_id != 'draft' AND date >= ?
			 ORDER BY date DESC
			 LIMIT 500`,
			// Dates are ISO strings; compare with one, not with datetime(), whose space sorts before "T".
			new Date(Date.now() - SUBJECT_JOIN_WINDOW_MS).toISOString(),
		).toArray();
		return pickSubjectThread(rows as unknown as SubjectRow[], subject, senderAddress);
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
			   AND date >= ?2`,
			Folders.SENT,
			new Date(Date.now() - 3_600_000).toISOString(),
		)][0] as { cnt: number } | undefined;

		if ((hourRow?.cnt ?? 0) >= 20) {
			return "Rate limit exceeded: max 20 emails per hour per mailbox";
		}

		const dayRow = [...this.ctx.storage.sql.exec(
			`SELECT COUNT(*) as cnt FROM emails
			 WHERE folder_id = ?1
			   AND date >= ?2`,
			Folders.SENT,
			new Date(Date.now() - 86_400_000).toISOString(),
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
