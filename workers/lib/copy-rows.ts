// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Mailbox-side SQL for the copy to D1 (docs/d1-migration-plan.md, Moving
 * existing deployments). Runs inside MailboxDO through the `Exec` adapter.
 *
 * The copy turns on tracking first. From then on every change also lands in
 * copy_outbox (see recordChanges), so the job can read pages at its own pace
 * and then re-copy whatever changed underneath it. The index outbox and its
 * pushes carry on as before, so the combined inbox keeps working.
 */
import { Folders } from "../../shared/folders";
import { CONVERSATION_ID_SQL, currentSeq, getMeta, setMeta } from "./index-rows";
import { folderToState } from "./message-meta";
import type { Exec } from "./sql-exec";

/** A page carries at most this many emails, and stops early once bodies pass COPY_PAGE_BYTES. */
export const COPY_PAGE_LIMIT = 100;
export const COPY_PAGE_BYTES = 8 * 1024 * 1024;

export interface CopyAttachment {
	id: string;
	email_id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id: string | null;
	disposition: string | null;
}

/** One email as stored, plus what the list derives from the rest of the mailbox. */
export interface CopyRow {
	id: string;
	folder_id: string;
	subject: string;
	sender: string;
	recipient: string;
	cc: string | null;
	bcc: string | null;
	date: string;
	read: boolean;
	starred: boolean;
	body: string;
	in_reply_to: string | null;
	email_references: string | null;
	thread_id: string | null;
	message_id: string | null;
	raw_headers: string | null;
	conversation_id: string;
	attachments: CopyAttachment[];
	labels: string[];
}

export interface CopyMeta {
	/** Custom folders only; D1 creates the system ones. */
	folders: { id: string; name: string; is_deletable: number }[];
	foldersImported: boolean;
	scheduled: { email_id: string; send_at: string; payload: string; attempts: number; error: string | null }[];
	sendKeys: { key: string; state: string; email_id: string | null; created_at: string }[];
}

/** What the parity report compares. Counts are per folder state, plus labels and scheduled sends. */
export interface CopyCounts {
	states: Record<string, { total: number; unread: number; starred: number }>;
	labels: Record<string, number>;
	attachments: number;
	scheduled: number;
}

export function copyTracking(exec: Exec): boolean {
	return getMeta(exec, "copy_tracking") === "1";
}

/** Start recording changes for the copy. Returns how many emails there are to copy. */
export function startCopyTracking(exec: Exec): { total: number } {
	if (!copyTracking(exec)) {
		exec(`DELETE FROM copy_outbox`);
		setMeta(exec, "copy_tracking", "1");
	}
	return { total: Number(exec(`SELECT COUNT(*) AS n FROM emails`)[0].n) };
}

export function stopCopyTracking(exec: Exec): void {
	setMeta(exec, "copy_tracking", "0");
	exec(`DELETE FROM copy_outbox`);
}

/** Full rows for these ids, in the order given. Ids that no longer exist are listed in `missing`. */
export function copyRows(exec: Exec, ids: string[]): { rows: CopyRow[]; missing: string[] } {
	if (ids.length === 0) return { rows: [], missing: [] };
	const list = JSON.stringify(ids);
	const found = exec(
		`SELECT e.id, e.folder_id, e.subject, e.sender, e.recipient, e.cc, e.bcc, e.date, e.read, e.starred, e.body,
			e.in_reply_to, e.email_references, e.thread_id, e.message_id, e.raw_headers,
			${CONVERSATION_ID_SQL} AS conversation_id
		FROM emails e WHERE e.id IN (SELECT value FROM json_each(?))`,
		list,
	);
	const attachments = new Map<string, CopyAttachment[]>();
	for (const a of exec(
		`SELECT id, email_id, filename, mimetype, size, content_id, disposition FROM attachments
		WHERE email_id IN (SELECT value FROM json_each(?)) ORDER BY id`,
		list,
	)) {
		const row: CopyAttachment = {
			id: String(a.id), email_id: String(a.email_id), filename: String(a.filename), mimetype: String(a.mimetype),
			size: Number(a.size), content_id: (a.content_id as string | null) ?? null, disposition: (a.disposition as string | null) ?? null,
		};
		attachments.set(row.email_id, [...(attachments.get(row.email_id) ?? []), row]);
	}
	const labels = new Map<string, string[]>();
	for (const l of exec(`SELECT email_id, label_id FROM email_labels WHERE email_id IN (SELECT value FROM json_each(?)) ORDER BY label_id`, list)) {
		const id = String(l.email_id);
		labels.set(id, [...(labels.get(id) ?? []), String(l.label_id)]);
	}
	const text = (v: unknown) => (v as string | null) ?? null;
	const byId = new Map(found.map((r) => [String(r.id), r]));
	const rows: CopyRow[] = [];
	const missing: string[] = [];
	for (const id of ids) {
		const r = byId.get(id);
		if (!r) {
			missing.push(id);
			continue;
		}
		rows.push({
			id, folder_id: String(r.folder_id), subject: String(r.subject ?? ""), sender: String(r.sender ?? ""),
			recipient: String(r.recipient ?? ""), cc: text(r.cc), bcc: text(r.bcc), date: String(r.date ?? ""),
			read: !!r.read, starred: !!r.starred, body: String(r.body ?? ""), in_reply_to: text(r.in_reply_to),
			email_references: text(r.email_references), thread_id: text(r.thread_id), message_id: text(r.message_id),
			raw_headers: text(r.raw_headers), conversation_id: String(r.conversation_id ?? id),
			attachments: attachments.get(id) ?? [], labels: labels.get(id) ?? [],
		});
	}
	return { rows, missing };
}

/** Emails after `afterId` in id order, at most `limit` and about COPY_PAGE_BYTES of bodies. */
export function copyPage(exec: Exec, afterId: string | null, limit = COPY_PAGE_LIMIT): { rows: CopyRow[]; nextAfterId: string | null } {
	const max = Math.min(Math.max(limit, 1), COPY_PAGE_LIMIT);
	const candidates = exec(`SELECT id, length(CAST(body AS BLOB)) AS bytes FROM emails WHERE id > ? ORDER BY id LIMIT ?`, afterId ?? "", max);
	const ids: string[] = [];
	let bytes = 0;
	for (const c of candidates) {
		// Always take one, so a single large body still moves.
		if (ids.length > 0 && bytes + Number(c.bytes ?? 0) > COPY_PAGE_BYTES) break;
		ids.push(String(c.id));
		bytes += Number(c.bytes ?? 0);
	}
	const more = ids.length < candidates.length || candidates.length === max;
	return { rows: copyRows(exec, ids).rows, nextAfterId: more && ids.length > 0 ? ids[ids.length - 1] : null };
}

/** Ids changed since tracking started (or since the last ack), oldest first. */
export function readCopyChanges(exec: Exec, limit = COPY_PAGE_LIMIT): { ids: string[]; seq: number } {
	const ids = exec(
		`SELECT email_id FROM copy_outbox GROUP BY email_id ORDER BY MIN(seq) LIMIT ?`,
		Math.min(Math.max(limit, 1), COPY_PAGE_LIMIT),
	).map((r) => String(r.email_id));
	return { ids, seq: currentSeq(exec) };
}

/** Drop the entries the copy has handled. Changes after `seq` stay. */
export function ackCopyChanges(exec: Exec, ids: string[], seq: number): void {
	exec(`DELETE FROM copy_outbox WHERE seq <= ? AND email_id IN (SELECT value FROM json_each(?))`, seq, JSON.stringify(ids));
}

export function pendingCopyChanges(exec: Exec): number {
	return Number(exec(`SELECT COUNT(DISTINCT email_id) AS n FROM copy_outbox`)[0].n);
}

export function copyMeta(exec: Exec): CopyMeta {
	const system = Object.values(Folders) as string[];
	return {
		folders: exec(`SELECT id, name, is_deletable FROM folders ORDER BY id`)
			.filter((f) => !system.includes(String(f.id)))
			.map((f) => ({ id: String(f.id), name: String(f.name), is_deletable: Number(f.is_deletable) })),
		foldersImported: getMeta(exec, "folders_imported") === "1",
		scheduled: exec(`SELECT email_id, send_at, payload, attempts, error FROM scheduled_sends ORDER BY email_id`).map((r) => ({
			email_id: String(r.email_id), send_at: String(r.send_at), payload: String(r.payload), attempts: Number(r.attempts),
			error: (r.error as string | null) ?? null,
		})),
		sendKeys: exec(`SELECT key, state, email_id, created_at FROM send_keys ORDER BY key`).map((r) => ({
			key: String(r.key), state: String(r.state), email_id: (r.email_id as string | null) ?? null, created_at: String(r.created_at),
		})),
	};
}

export function copyCounts(exec: Exec): CopyCounts {
	const states: CopyCounts["states"] = {};
	for (const r of exec(
		`SELECT folder_id, COUNT(*) AS n, SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) AS unread, SUM(CASE WHEN starred = 1 THEN 1 ELSE 0 END) AS starred
		FROM emails GROUP BY folder_id`,
	)) {
		const state = folderToState(String(r.folder_id));
		const s = (states[state] ??= { total: 0, unread: 0, starred: 0 });
		s.total += Number(r.n);
		s.unread += Number(r.unread);
		s.starred += Number(r.starred);
	}
	const labels: Record<string, number> = {};
	for (const r of exec(`SELECT label_id, COUNT(*) AS n FROM email_labels GROUP BY label_id`)) labels[String(r.label_id)] = Number(r.n);
	return {
		states,
		labels,
		attachments: Number(exec(`SELECT COUNT(*) AS n FROM attachments`)[0].n),
		scheduled: Number(exec(`SELECT COUNT(*) AS n FROM scheduled_sends`)[0].n),
	};
}
