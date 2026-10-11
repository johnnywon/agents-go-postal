// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Scheduled sends, stored in each mailbox's scheduled_sends table. The row's
 * email_id is the draft that holds the message; MailboxDO's alarm sends due
 * rows through the shared send path.
 */
import { z } from "zod";
import { SendEmailRequestSchema } from "./schemas";
import type { SendMode, SendEmailRequest } from "./send";
import type { Exec } from "./sql-exec";

export const SCHEDULE_MIN_LEAD_MS = 30_000;
export const SCHEDULE_MAX_LEAD_MS = 366 * 24 * 60 * 60_000;
export const SCHEDULE_MAX_PAYLOAD_BYTES = 1_500_000;
export const SCHEDULE_RETRY_MS = 15 * 60_000;
export const SCHEDULE_MAX_ATTEMPTS = 3;

export const ScheduleModeSchema = z.enum(["new", "reply", "reply-all", "forward"]);
export type ScheduleMode = z.infer<typeof ScheduleModeSchema>;

export const ScheduleBody = z
	.object({
		sendAt: z.string().datetime({ offset: true }),
		draft_id: z.string().min(1).optional(),
		mode: ScheduleModeSchema,
		original_id: z.string().min(1).optional(),
		email: SendEmailRequestSchema,
	})
	.refine((b) => b.mode === "new" || !!b.original_id, {
		message: "original_id is required for reply, reply-all and forward",
	});

export interface ScheduledPayload {
	mode: ScheduleMode;
	original_id?: string;
	email: SendEmailRequest;
}

export interface ScheduledRow {
	emailId: string;
	sendAt: string;
	attempts: number;
	error: string | null;
}

/** Null when sendAt is acceptable, else the error to show. */
export function checkSendAt(sendAt: string, now = Date.now()): string | null {
	const at = Date.parse(sendAt);
	if (Number.isNaN(at)) return "sendAt must be an ISO date and time";
	if (at < now + SCHEDULE_MIN_LEAD_MS) return "sendAt must be at least 30 seconds from now";
	if (at >= now + SCHEDULE_MAX_LEAD_MS) return "sendAt must be less than 366 days from now";
	return null;
}

export function sendModeOf(payload: ScheduledPayload): SendMode {
	if (!payload.original_id || payload.mode === "new") return { kind: "new" };
	if (payload.mode === "forward") return { kind: "forward", originalId: payload.original_id };
	return { kind: "reply", originalId: payload.original_id };
}

function toRow(r: Record<string, unknown>): ScheduledRow {
	return {
		emailId: String(r.email_id),
		sendAt: String(r.send_at),
		attempts: Number(r.attempts),
		error: r.error == null ? null : String(r.error),
	};
}

export function insertScheduled(exec: Exec, emailId: string, sendAt: string, payload: ScheduledPayload): void {
	exec(
		`INSERT OR REPLACE INTO scheduled_sends (email_id, send_at, payload, attempts, error) VALUES (?, ?, ?, 0, NULL)`,
		emailId, new Date(sendAt).toISOString(), JSON.stringify(payload),
	);
}

export function listScheduledRows(exec: Exec): ScheduledRow[] {
	return exec(`SELECT email_id, send_at, attempts, error FROM scheduled_sends ORDER BY send_at, email_id`).map(toRow);
}

export function deleteScheduledRow(exec: Exec, emailId: string): boolean {
	return exec(`DELETE FROM scheduled_sends WHERE email_id = ? RETURNING email_id`, emailId).length > 0;
}

/** Rows due now that have attempts left. */
export function dueScheduled(exec: Exec, now = Date.now()): (ScheduledRow & { payload: string })[] {
	return exec(
		`SELECT email_id, send_at, attempts, error, payload FROM scheduled_sends
		WHERE send_at <= ? AND attempts < ? ORDER BY send_at, email_id`,
		new Date(now).toISOString(), SCHEDULE_MAX_ATTEMPTS,
	).map((r) => ({ ...toRow(r), payload: String(r.payload) }));
}

/** Earliest send time that still has attempts left, in ms, or null. */
export function nextScheduledAt(exec: Exec): number | null {
	const row = exec(`SELECT MIN(send_at) AS at FROM scheduled_sends WHERE attempts < ?`, SCHEDULE_MAX_ATTEMPTS)[0];
	return row?.at ? Date.parse(String(row.at)) : null;
}

/**
 * Count a failed attempt. With attempts left the row retries in 15 minutes
 * (send_at moves); after the last one it keeps its error and stops.
 */
export function recordScheduledFailure(exec: Exec, emailId: string, error: string, now = Date.now()): number {
	const row = exec(
		`UPDATE scheduled_sends SET attempts = attempts + 1, error = ? WHERE email_id = ? RETURNING attempts`,
		error.slice(0, 1000), emailId,
	)[0];
	const attempts = Number(row?.attempts ?? SCHEDULE_MAX_ATTEMPTS);
	if (attempts < SCHEDULE_MAX_ATTEMPTS) {
		exec(`UPDATE scheduled_sends SET send_at = ? WHERE email_id = ?`, new Date(now + SCHEDULE_RETRY_MS).toISOString(), emailId);
	}
	return attempts;
}

export interface RunScheduledDeps {
	exec: Exec;
	/** The draft's folder, or null when it no longer exists. */
	draftFolder: (emailId: string) => Promise<string | null>;
	deleteDraft: (emailId: string) => Promise<unknown>;
	/** Send; resolves with an error string on a refused send, throws on delivery failure. */
	send: (payload: ScheduledPayload) => Promise<string | null>;
	now?: () => number;
}

/** Send every due row. Returns what happened to each. */
export async function runDueScheduled(deps: RunScheduledDeps, draftFolderId: string) {
	const now = deps.now ?? Date.now;
	const sent: string[] = [];
	const dropped: string[] = [];
	const failed: string[] = [];
	for (const row of dueScheduled(deps.exec, now())) {
		// Edited or deleted drafts are gone: drop the schedule without sending.
		if ((await deps.draftFolder(row.emailId)) !== draftFolderId) {
			deleteScheduledRow(deps.exec, row.emailId);
			dropped.push(row.emailId);
			continue;
		}
		let error: string | null;
		try {
			error = await deps.send(JSON.parse(row.payload) as ScheduledPayload);
		} catch (e) {
			error = (e as Error).message || "Delivery failed";
		}
		if (error) {
			recordScheduledFailure(deps.exec, row.emailId, error, now());
			failed.push(row.emailId);
			continue;
		}
		deleteScheduledRow(deps.exec, row.emailId);
		await deps.deleteDraft(row.emailId);
		sent.push(row.emailId);
	}
	return { sent, dropped, failed };
}
