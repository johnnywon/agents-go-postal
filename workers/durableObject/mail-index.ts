// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";
import type { IndexRow } from "../lib/index-rows";
import {
	applyRows,
	createIndexSchema,
	folderViews,
	getIndexMeta,
	getRebuildJob,
	indexCounts,
	messageCount,
	purgeMailbox,
	queryFacets,
	queryMail,
	runSync,
	saveRebuildProgress,
	setIndexMeta,
	startRebuildJob,
	sweepMailbox,
	type MailFilter,
} from "../lib/mail-index-sql";
import {
	createSavedSearchQuery,
	deleteSavedSearchQuery,
	listSavedSearchesQuery,
	savedResult,
	suggestQuery,
	updateSavedSearchQuery,
} from "../lib/search-suggest-sql";
import { indexedMailboxIds } from "../lib/mail-index-stub";
import {
	type BulkAction,
	BulkConflictError,
	type BulkOp,
	LabelError,
	allLabels,
	createBulkJob,
	createLabel,
	deleteLabelRows,
	getBulkJob,
	labelBackup,
	labelThreadKeys,
	listLabels,
	markLabelsAuto,
	nextBulkOps,
	opSize,
	planBulk,
	planEmptyTrash,
	planUndo,
	pruneBulkJobs,
	matchingThreadKeys,
	resolveFilterTarget,
	restoreLabels,
	saveBulkProgress,
	saveUndo,
	takeUndo,
	threadKeyOf,
	trashCount,
	updateLabel,
} from "../lib/mail-bulk-sql";
import { fromSqlStorage, type Exec } from "../lib/sql-exec";

const MAX_BATCH_ROWS = 100;
const REBUILD_PAGES_PER_ALARM = 25;
const REBUILD_RETRY_MS = 30_000;
/** Above this many messages a bulk action runs as an alarm job. */
const BULK_INLINE_LIMIT = 500;
const BULK_OPS_PER_ALARM = 20;
const LABELS_BACKUP = "backups/labels.json";

export type BulkTarget =
	| { threadKeys: string[]; view: string }
	| { filter: MailFilter; asOf: string; expectedCount: number };

export interface BulkFailure {
	mailboxId: string;
	error: string;
}

/**
 * Global read model over every mailbox: one combined list, facets and
 * full-text search. Mailbox DOs stay the source of truth; this index can be
 * dropped and rebuilt from them at any time.
 */
export class MailIndexDO extends DurableObject<Env> {
	exec: Exec;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.exec = fromSqlStorage(ctx.storage.sql);
		createIndexSchema(this.exec);
		this.#probe();
	}

	/** Log once that FTS5 contentless delete works in production. */
	#probe() {
		if (getIndexMeta(this.exec, "probe")) return;
		let result: string;
		try {
			this.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS probe_fts USING fts5(a, content='', contentless_delete=1)`);
			this.exec(`INSERT INTO probe_fts (rowid, a) VALUES (1, 'probe alpha'), (2, 'probe beta')`);
			this.exec(`DELETE FROM probe_fts WHERE rowid = 1`);
			const hits = this.exec(`SELECT rowid FROM probe_fts WHERE probe_fts MATCH 'probe'`).map((r) => Number(r.rowid));
			this.exec(`DROP TABLE probe_fts`);
			result = hits.length === 1 && hits[0] === 2 ? "ok" : `unexpected ${JSON.stringify(hits)}`;
		} catch (e) {
			result = `error ${(e as Error).message}`;
		}
		console.log(`mail index probe: fts5 contentless_delete ${result}`);
		setIndexMeta(this.exec, "probe", result);
	}

	async applyBatch(mailboxId: string, rows: IndexRow[]) {
		if (rows.length > MAX_BATCH_ROWS) throw new Error(`Batch too large: ${rows.length}`);
		return this.ctx.storage.transactionSync(() => applyRows(this.exec, mailboxId.toLowerCase(), rows));
	}

	async purgeMailbox(mailboxId: string) {
		return this.ctx.storage.transactionSync(() => purgeMailbox(this.exec, mailboxId.toLowerCase()));
	}

	async queryMail(filter: MailFilter, options: { cursor?: string | null; limit?: number } = {}) {
		await this.#startIfEmpty();
		return { ...queryMail(this.exec, filter, options), indexing: this.#indexing() };
	}

	async queryFacets(filter: MailFilter) {
		await this.#startIfEmpty();
		return queryFacets(this.exec, filter);
	}

	async folderViews() {
		return folderViews(this.exec);
	}

	// ── Search window ────────────────────────────────────────────────

	async suggest(filter: MailFilter, text: string, at: number) {
		await this.#startIfEmpty();
		return runSync(suggestQuery(filter, text, at), this.exec);
	}

	async listSavedSearches(counts?: { tzOffset: number }) {
		return runSync(listSavedSearchesQuery(counts && { engine: "index", tzOffset: counts.tzOffset }), this.exec);
	}

	async createSavedSearch(input: { name?: unknown; query: unknown }) {
		return savedResult(() => runSync(createSavedSearchQuery(input), this.exec));
	}

	async updateSavedSearch(id: string, input: { name?: unknown; query?: unknown; position?: unknown }) {
		return savedResult(() => runSync(updateSavedSearchQuery(id, input), this.exec));
	}

	async deleteSavedSearch(id: string) {
		return runSync(deleteSavedSearchQuery(id), this.exec);
	}

	/** Labels and saved searches, for the copy to D1. */
	async copyGlobals() {
		return {
			labels: this.exec(`SELECT id, name, color, position FROM labels ORDER BY id`),
			labelAuto: this.exec(`SELECT label_id, applied_at FROM label_auto ORDER BY label_id`),
			savedSearches: this.exec(`SELECT id, name, filter, position FROM saved_searches ORDER BY id`),
		};
	}

	async status() {
		await this.#startIfEmpty();
		return {
			counts: indexCounts(this.exec),
			messages: messageCount(this.exec),
			job: getRebuildJob(this.exec),
			probe: getIndexMeta(this.exec, "probe"),
		};
	}

	/** Re-read every configured mailbox under a new generation. */
	async startRebuild() {
		await this.#restoreLabelsBackup();
		const mailboxes = await indexedMailboxIds(this.env);
		const job = startRebuildJob(this.exec, mailboxes);
		await this.ctx.storage.setAlarm(Date.now());
		return job;
	}

	#indexing() {
		const job = getRebuildJob(this.exec);
		return job && !job.finishedAt ? { done: job.position, total: job.mailboxes.length } : null;
	}

	async #startIfEmpty() {
		if (messageCount(this.exec) === 0 && !getRebuildJob(this.exec)) await this.startRebuild();
	}

	/** Rebuild steps first, then bulk job steps; reschedules while either has work. */
	async alarm() {
		const delays = [await this.#rebuildStep(), await this.#bulkStep()].filter((d): d is number => d !== null);
		if (delays.length > 0) await this.ctx.storage.setAlarm(Date.now() + Math.min(...delays));
	}

	/** Rebuild: one export page per step, progress saved after each page. Returns the next delay, or null when idle. */
	async #rebuildStep(): Promise<number | null> {
		let job = getRebuildJob(this.exec);
		if (!job || job.finishedAt) return null;
		try {
			for (let page = 0; page < REBUILD_PAGES_PER_ALARM; page++) {
				const mailboxId = job.mailboxes[job.position];
				if (!mailboxId) {
					this.#finishRebuild(job.mailboxes);
					return null;
				}
				const stub = this.env.MAILBOX.get(this.env.MAILBOX.idFromName(mailboxId));
				const exported = await stub.exportIndexRows({ mailboxId, afterId: job.afterId, limit: MAX_BATCH_ROWS });
				const generation = job.generation;
				this.ctx.storage.transactionSync(() => {
					applyRows(this.exec, mailboxId, exported.rows as IndexRow[], { generation });
					if (exported.nextAfterId) {
						saveRebuildProgress(this.exec, { position: job!.position, afterId: exported.nextAfterId });
					} else {
						sweepMailbox(this.exec, mailboxId, generation);
						saveRebuildProgress(this.exec, { position: job!.position + 1, afterId: null });
					}
				});
				if (!exported.nextAfterId) {
					// The mailbox now knows its address; send anything it recorded before that.
					await stub.flushIndex();
				}
				job = getRebuildJob(this.exec)!;
			}
			return 0;
		} catch (e) {
			const message = (e as Error).message;
			console.error("mail index rebuild failed:", message);
			saveRebuildProgress(this.exec, { position: job.position, afterId: job.afterId, error: message });
			return REBUILD_RETRY_MS;
		}
	}

	async #bulkStep(): Promise<number | null> {
		const next = nextBulkOps(this.exec, BULK_OPS_PER_ALARM);
		if (!next) {
			pruneBulkJobs(this.exec);
			return null;
		}
		const result = await this.#runOps(next.ops);
		saveBulkProgress(this.exec, next.id, { ops: next.ops.length, ...result });
		return 0;
	}

	// ── Bulk actions ───────────────────────────────────────────────

	/** Apply ops through the owning mailboxes. A failing mailbox is reported, the others still run. */
	async #runOps(ops: BulkOp[]): Promise<{ affected: number; failed: BulkFailure[] }> {
		let affected = 0;
		const failed = new Map<string, string>();
		for (const op of ops) {
			if (failed.has(op.mailboxId)) continue;
			const stub = this.env.MAILBOX.get(this.env.MAILBOX.idFromName(op.mailboxId));
			try {
				if (op.kind === "purge") {
					const result = await stub.purgeTrash(op.emailIds);
					affected += result.changed.length;
					await this.#deleteBlobs(result.attachments);
					continue;
				}
				const result = op.kind === "move" ? await stub.moveEmails(op.emailIds, op.to, op.from)
					: op.kind === "flags" ? await stub.updateEmails(op.emailIds, op.patch)
					: await stub.setLabels(op.emailIds, { add: op.add, remove: op.remove });
				affected += result.changed.length;
			} catch (e) {
				failed.set(op.mailboxId, (e as Error).message);
			}
		}
		return { affected, failed: [...failed].map(([mailboxId, error]) => ({ mailboxId, error })) };
	}

	/**
	 * Plan, record undo and apply. Small actions run now; above 500 messages the
	 * action becomes an alarm job and this returns its id.
	 */
	async bulk(target: BulkTarget, action: BulkAction) {
		let threadKeys: string[];
		try {
			threadKeys = "threadKeys" in target
				? target.threadKeys
				: resolveFilterTarget(this.exec, target.filter, target.asOf, target.expectedCount);
		} catch (e) {
			// Errors lose their class across RPC; report the conflict as a value.
			if (e instanceof BulkConflictError) return { conflict: e.count };
			throw e;
		}
		const view = "threadKeys" in target ? target.view : target.filter.view;
		const plan = planBulk(this.exec, threadKeys, view, action);
		const undoId = crypto.randomUUID();
		this.ctx.storage.transactionSync(() => saveUndo(this.exec, undoId, { action, entries: plan.entries }));
		const total = opSize(plan.ops);
		if (total > BULK_INLINE_LIMIT) {
			const jobId = crypto.randomUUID();
			createBulkJob(this.exec, jobId, action, plan.ops, undoId);
			await this.ctx.storage.setAlarm(Date.now());
			return { job: { jobId, total, undoId } };
		}
		const result = await this.#runOps(plan.ops);
		return { affected: result.affected, undoId, failed: result.failed };
	}

	/** Attachment blobs of purged mail. The mail is already gone, so a failure is logged, not reported. */
	async #deleteBlobs(attachments: { emailId: string; id: string; filename: string }[]) {
		if (attachments.length === 0) return;
		try {
			await this.env.BUCKET.delete(attachments.map((a) => `attachments/${a.emailId}/${a.id}/${a.filename}`));
		} catch (e) {
			console.error("empty trash: attachment delete failed:", (e as Error).message);
		}
	}

	async trashCount() {
		return trashCount(this.exec);
	}

	/**
	 * Permanently delete every message in Trash, through each mailbox. No
	 * undo. The count must match the one the user confirmed. Above 500
	 * messages it runs as an alarm job.
	 */
	async emptyTrash(expectedCount: number) {
		let ops: BulkOp[];
		try {
			ops = planEmptyTrash(this.exec, expectedCount);
		} catch (e) {
			if (e instanceof BulkConflictError) return { conflict: e.count };
			throw e;
		}
		const total = opSize(ops);
		if (total > BULK_INLINE_LIMIT) {
			const jobId = crypto.randomUUID();
			createBulkJob(this.exec, jobId, { type: "empty_trash" }, ops, "");
			await this.ctx.storage.setAlarm(Date.now());
			return { job: { jobId, total, undoId: "" } };
		}
		const result = await this.#runOps(ops);
		return { deleted: result.affected, failed: result.failed };
	}

	async bulkJob(jobId: string) {
		return getBulkJob(this.exec, jobId);
	}

	/** Reverse a bulk action within the hour. Null when the record is gone. */
	async undo(undoId: string) {
		const payload = this.ctx.storage.transactionSync(() => takeUndo(this.exec, undoId));
		if (!payload) return null;
		return this.#runOps(planUndo(payload));
	}

	/** Conversations matching a filter, for agent tools that act on a whole search. */
	async threadKeysMatching(filter: MailFilter, limit: number) {
		await this.#startIfEmpty();
		return matchingThreadKeys(this.exec, filter, limit);
	}

	async threadKeyOf(mailboxId: string, emailId: string) {
		return threadKeyOf(this.exec, mailboxId, emailId);
	}

	// ── Labels ─────────────────────────────────────────────────────

	async listLabels() {
		return listLabels(this.exec);
	}

	async createLabel(input: { name: unknown; color?: unknown; id?: string }) {
		try {
			const label = createLabel(this.exec, input);
			await this.#backupLabels();
			return { label };
		} catch (e) {
			if (e instanceof LabelError) return { error: e.message };
			throw e;
		}
	}

	async updateLabel(id: string, input: { name?: unknown; color?: unknown }) {
		try {
			const label = updateLabel(this.exec, id, input);
			if (label) await this.#backupLabels();
			return { label };
		} catch (e) {
			if (e instanceof LabelError) return { error: e.message };
			throw e;
		}
	}

	/** Flag labels as applied by an agent (MCP or chat). Returns the ids newly flagged. */
	async markLabelsAuto(ids: string[]) {
		const flagged = this.ctx.storage.transactionSync(() => markLabelsAuto(this.exec, ids));
		if (flagged.length > 0) await this.#backupLabels();
		return { flagged };
	}

	/** Remove the label from every message, then the definition. */
	async deleteLabel(id: string) {
		if (!allLabels(this.exec).some((l) => l.id === id)) return null;
		const plan = planBulk(this.exec, labelThreadKeys(this.exec, id), "all", { type: "label_remove", labelId: id });
		const result = await this.#runOps(plan.ops);
		if (result.failed.length > 0) return { deleted: false, ...result };
		this.ctx.storage.transactionSync(() => deleteLabelRows(this.exec, id));
		await this.#backupLabels();
		return { deleted: true, ...result };
	}

	async #backupLabels() {
		await this.env.BUCKET.put(LABELS_BACKUP, JSON.stringify(labelBackup(this.exec)), {
			httpMetadata: { contentType: "application/json" },
		});
	}

	async #restoreLabelsBackup() {
		try {
			const object = await this.env.BUCKET.get(LABELS_BACKUP);
			if (!object) return;
			const restored = restoreLabels(this.exec, await object.json());
			if (restored > 0) console.log(`mail index restored ${restored} labels from ${LABELS_BACKUP}`);
		} catch (e) {
			console.error("label backup restore failed:", (e as Error).message);
		}
	}

	#finishRebuild(mailboxes: string[]) {
		const keep = new Set(mailboxes);
		this.ctx.storage.transactionSync(() => {
			for (const row of this.exec(`SELECT DISTINCT mailbox_id FROM messages`)) {
				const id = String(row.mailbox_id);
				if (!keep.has(id)) purgeMailbox(this.exec, id);
			}
			saveRebuildProgress(this.exec, {
				position: mailboxes.length,
				afterId: null,
				finishedAt: new Date().toISOString(),
			});
		});
		console.log(`mail index rebuild finished: ${messageCount(this.exec)} messages from ${mailboxes.length} mailboxes`);
	}
}
