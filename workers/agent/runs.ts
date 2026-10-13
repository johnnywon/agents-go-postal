// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Auto-draft runs, one per inbound message, in the auto_draft_runs table.
 *
 * Inbound mail records a run and sends it to the DRAFT_QUEUE queue. The
 * consumer drafts, and a failed attempt goes back to the queue with backoff;
 * after AUTO_DRAFT_MAX_RETRIES retries the queue moves it to the dead-letter
 * queue and the run stays failed. A deployment without the queue binding
 * runs the draft once in waitUntil.
 *
 * New mail in a thread supersedes the thread's earlier runs. A superseded run
 * is not started, and a draft from a run superseded while it ran is discarded:
 * the newer mail gets its own draft. Each sender gets autoDraftPerSender
 * drafts per address a day (Console > Limits); later mail is stored but not drafted.
 */
import { DEFAULT_AGENT_LIMITS } from "../../shared/send-limits";
import type { Sql } from "../store/sql";

/** Must match max_retries on the queue consumer in wrangler.jsonc. */
export const AUTO_DRAFT_MAX_RETRIES = 3;
/** A run still marked running after this long died; the queue's redelivery takes it over. */
export const RUN_STALE_MS = 10 * 60_000;
/** A run still running after this long has no redelivery coming; the hourly cron marks it failed. */
export const RUN_ABANDONED_MS = 60 * 60_000;

export type RunState = "queued" | "running" | "drafted" | "skipped" | "superseded" | "failed";

/** The queue message. Everything else is read from the run's row. */
export interface AutoDraftJob {
	emailId: string;
}

export interface AutoDraftTarget {
	mailboxId: string;
	emailId: string;
	sender: string;
	threadId: string;
}

export type DraftOutcome =
	/** `earlier` holds drafts saved before `draftId` in the same run, when the model drafted more than once. */
	| { status: "drafted"; draftId: string | null; earlier?: string[] }
	| { status: "skipped"; reason: string }
	| { status: "error"; error: string };

export type Drafter = (target: AutoDraftTarget) => Promise<DraftOutcome>;

/** A drafted outcome for the drafts one run saved, oldest first. */
export function draftedOutcome(draftIds: string[]): DraftOutcome {
	const draftId = draftIds.at(-1) ?? null;
	return draftIds.length > 1 ? { status: "drafted", draftId, earlier: draftIds.slice(0, -1) } : { status: "drafted", draftId };
}

/**
 * The outcome when drafting throws. A draft that was already saved settles the
 * run as drafted: a retry would draft the same reply again.
 */
export function outcomeAfterError(error: unknown, draftIds: string[]): DraftOutcome {
	const message = (error as Error)?.message || "Auto-draft failed";
	return draftIds.length ? draftedOutcome(draftIds) : { status: "error", error: message };
}

/** Seconds before retry n (1-based): 30, 60, 120. */
export const retryDelay = (attempt: number) => 30 * 2 ** Math.max(0, attempt - 1);

/**
 * Record a run for new inbound mail, superseding the thread's earlier runs.
 * Returns the new run's state, or null when this message already has one.
 */
export async function recordRun(sql: Sql, target: AutoDraftTarget, now = Date.now(), perSender = DEFAULT_AGENT_LIMITS.autoDraftPerSender): Promise<{ state: "queued" | "skipped"; reason: string | null } | null> {
	const at = new Date(now).toISOString();
	const dayAgo = new Date(now - 86_400_000).toISOString();
	const [, inserted] = await sql.batch([
		{
			sql: `UPDATE auto_draft_runs SET state = 'superseded', reason = 'newer mail in the thread', updated_at = ?
				WHERE mailbox_id = ? AND thread_id = ? AND email_id != ? AND state IN ('queued', 'running')`,
			params: [at, target.mailboxId, target.threadId, target.emailId],
		},
		{
			sql: `INSERT INTO auto_draft_runs (email_id, mailbox_id, thread_id, sender, state, reason, created_at, updated_at)
				SELECT ?1, ?2, ?3, ?4,
					CASE WHEN n < ?6 THEN 'queued' ELSE 'skipped' END,
					CASE WHEN n < ?6 THEN NULL ELSE ?7 END,
					?5, ?5
				FROM (SELECT COUNT(*) AS n FROM auto_draft_runs
					WHERE mailbox_id = ?2 AND sender = ?4 AND created_at >= ?8 AND state IN ('queued', 'running', 'drafted', 'failed'))
				WHERE 1
				ON CONFLICT (email_id) DO NOTHING
				RETURNING state, reason`,
			params: [
				target.emailId, target.mailboxId, target.threadId, target.sender, at,
				perSender, `sender limit: ${perSender} auto-drafts a day`, dayAgo,
			],
		},
	]);
	if (inserted.length === 0) return null;
	const row = inserted[0];
	return { state: row.state === "queued" ? "queued" : "skipped", reason: row.reason == null ? null : String(row.reason) };
}

/** queued -> running, or take over a run that died. Null when there is nothing to run. */
export async function claimRun(sql: Sql, emailId: string, now = Date.now()): Promise<(AutoDraftTarget & { attempts: number }) | null> {
	const row = await sql.first(
		`UPDATE auto_draft_runs SET state = 'running', attempts = attempts + 1, updated_at = ?
		WHERE email_id = ? AND (state = 'queued' OR (state = 'running' AND updated_at < ?))
		RETURNING email_id, mailbox_id, thread_id, sender, attempts`,
		new Date(now).toISOString(), emailId, new Date(now - RUN_STALE_MS).toISOString(),
	);
	if (!row) return null;
	return {
		emailId: String(row.email_id), mailboxId: String(row.mailbox_id), threadId: String(row.thread_id),
		sender: String(row.sender), attempts: Number(row.attempts),
	};
}

/** Settle a running run. False when it was superseded while it ran. */
export async function settleRun(sql: Sql, emailId: string, state: RunState, fields: { reason?: string | null; draftId?: string | null } = {}): Promise<boolean> {
	const rows = await sql.all(
		`UPDATE auto_draft_runs SET state = ?, reason = ?, draft_id = ?, updated_at = ? WHERE email_id = ? AND state = 'running' RETURNING email_id`,
		state, fields.reason?.slice(0, 1000) ?? null, fields.draftId ?? null, new Date().toISOString(), emailId,
	);
	return rows.length > 0;
}

/**
 * One attempt at a run. "retry" asks the queue to try again later; on the
 * last attempt the run is marked failed and the queue moves the message on to
 * its dead-letter queue. `{ wait }` means the run is still marked running,
 * by another delivery or by a worker that died: try again in `wait` seconds,
 * once a dead run can be taken over.
 */
export async function attemptRun(
	sql: Sql,
	job: AutoDraftJob,
	drafter: Drafter,
	options: { final: boolean; discardDraft: (mailboxId: string, draftId: string) => Promise<unknown> },
): Promise<"done" | "retry" | { wait: number }> {
	const now = Date.now();
	const run = await claimRun(sql, job.emailId, now);
	if (!run) {
		const row = await sql.first(`SELECT state, updated_at FROM auto_draft_runs WHERE email_id = ?`, job.emailId);
		if (row?.state !== "running") return "done";
		const staleAt = Date.parse(String(row.updated_at)) + RUN_STALE_MS;
		return { wait: Math.max(1, Math.ceil((staleAt - now) / 1000) + 5) };
	}
	let outcome: DraftOutcome;
	try {
		const { attempts: _, ...target } = run;
		outcome = (await drafter(target)) ?? { status: "error", error: "The agent returned nothing" };
	} catch (e) {
		outcome = { status: "error", error: (e as Error).message || "Auto-draft failed" };
	}
	if (outcome.status === "error") {
		await settleRun(sql, run.emailId, options.final ? "failed" : "queued", { reason: outcome.error });
		return "retry";
	}
	if (outcome.status === "skipped") {
		await settleRun(sql, run.emailId, "skipped", { reason: outcome.reason });
		return "done";
	}
	const kept = await settleRun(sql, run.emailId, "drafted", { draftId: outcome.draftId });
	if (!kept) {
		for (const id of [...(outcome.earlier ?? []), outcome.draftId]) {
			if (id) await options.discardDraft(run.mailboxId, id).catch(() => {});
		}
	}
	return "done";
}

export interface RunRow {
	emailId: string;
	mailboxId: string;
	sender: string;
	state: RunState;
	attempts: number;
	reason: string | null;
	draftId: string | null;
	createdAt: string;
	updatedAt: string;
}

/** The latest runs, newest first, for Console > Activity. */
export async function listRuns(sql: Sql, options: { mailboxId?: string | null; limit?: number } = {}): Promise<RunRow[]> {
	return (await sql.all(
		`SELECT email_id, mailbox_id, sender, state, attempts, reason, draft_id, created_at, updated_at FROM auto_draft_runs
		WHERE (?1 IS NULL OR mailbox_id = ?1) ORDER BY created_at DESC LIMIT ?2`,
		options.mailboxId?.toLowerCase() ?? null, Math.min(Math.max(options.limit ?? 20, 1), 100),
	)).map((r) => ({
		emailId: String(r.email_id), mailboxId: String(r.mailbox_id), sender: String(r.sender), state: String(r.state) as RunState,
		attempts: Number(r.attempts), reason: r.reason == null ? null : String(r.reason), draftId: r.draft_id == null ? null : String(r.draft_id),
		createdAt: String(r.created_at), updatedAt: String(r.updated_at),
	}));
}

/** Mark failed the runs left running with no redelivery coming. */
export async function failAbandonedRuns(sql: Sql, now = Date.now()): Promise<number> {
	return (await sql.run(
		`UPDATE auto_draft_runs SET state = 'failed', reason = 'the run stopped before it finished', updated_at = ?
		WHERE state = 'running' AND updated_at < ?`,
		new Date(now).toISOString(), new Date(now - RUN_ABANDONED_MS).toISOString(),
	)).changes;
}

/** Runs are kept as long as the activity log. */
export async function pruneRuns(sql: Sql, days: number, now = Date.now()): Promise<number> {
	return (await sql.run(`DELETE FROM auto_draft_runs WHERE created_at < ?`, new Date(now - days * 86_400_000).toISOString())).changes;
}
