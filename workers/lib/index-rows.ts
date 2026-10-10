// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Mailbox-side index SQL: the outbox, and the rows a mailbox sends to
 * MailIndexDO. Runs inside MailboxDO through the `Exec` adapter.
 */

import { Folders } from "../../shared/folders";
import { folderToState, htmlToText, listHeaders, parseSender } from "./message-meta";
import type { Exec } from "./sql-exec";

export interface IndexRow {
	email_id: string;
	seq: number;
	/** Tombstone: the email no longer exists. Other fields are empty. */
	deleted: boolean;
	conversation_id: string;
	message_id: string | null;
	state: string;
	date: string;
	sender_addr: string;
	sender_name: string;
	sender_domain: string;
	recipients: string;
	subject: string;
	subject_norm: string;
	snippet: string;
	unread: boolean;
	starred: boolean;
	has_attachment: boolean;
	list_id: string | null;
	unsubscribe: string | null;
	body_text: string;
	labels: string[];
}

/** Pushes and exports never carry more than this many rows. */
export const INDEX_BATCH_LIMIT = 99;
const EXPORT_LIMIT = 100;
const SNIPPET_LENGTH = 200;

/** Same normalization as MailboxDO's NORMALIZED_SUBJECT_SQL, for any column. */
export function normalizedSubjectSql(column: string): string {
	return `LOWER(TRIM(
	REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
		LOWER(${column}),
		'aw: ', ''), 'wg: ', ''), 'réf: ', ''), 'sv: ', ''),
		're: ', ''), 'fwd: ', ''), 'fw: ', '')
))`;
}

export function getMeta(exec: Exec, key: string): string | null {
	const row = exec(`SELECT value FROM index_meta WHERE key = ?`, key)[0];
	return row ? String(row.value) : null;
}

export function setMeta(exec: Exec, key: string, value: string): void {
	exec(`INSERT INTO index_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value);
}

export function currentSeq(exec: Exec): number {
	return Number(getMeta(exec, "seq") ?? 0);
}

/** Record that these emails changed. Call inside the same transactionSync as the change. */
export function recordChanges(exec: Exec, ids: string[]): number {
	const unique = [...new Set(ids.filter(Boolean))];
	if (unique.length === 0) return currentSeq(exec);
	const seq = Number(
		exec(`UPDATE index_meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'seq' RETURNING value`)[0].value,
	);
	exec(
		`INSERT OR IGNORE INTO index_outbox (seq, email_id) SELECT ?, value FROM json_each(?)`,
		seq,
		JSON.stringify(unique),
	);
	return seq;
}

/**
 * The next batch to push: up to 99 changed emails, oldest change first, each
 * row stamped with the current seq because it carries the current state.
 */
export function readOutbox(exec: Exec, limit = INDEX_BATCH_LIMIT): { rows: IndexRow[]; seq: number } {
	const ids = exec(
		`SELECT email_id FROM index_outbox GROUP BY email_id ORDER BY MIN(seq) LIMIT ?`,
		Math.min(Math.max(limit, 1), INDEX_BATCH_LIMIT),
	).map((row) => String(row.email_id));
	const seq = currentSeq(exec);
	return { rows: buildIndexRows(exec, ids, seq), seq };
}

/** Drop outbox entries the index has applied. Later changes keep higher seqs and stay. */
export function ackOutbox(exec: Exec, ids: string[], seq: number): void {
	exec(
		`DELETE FROM index_outbox WHERE seq <= ? AND email_id IN (SELECT value FROM json_each(?))`,
		seq,
		JSON.stringify(ids),
	);
}

export function pendingCount(exec: Exec): number {
	return Number(exec(`SELECT COUNT(DISTINCT email_id) AS n FROM index_outbox`)[0].n);
}

/** Index rows for the given ids. Missing ids come back as tombstones. */
export function buildIndexRows(exec: Exec, ids: string[], seq: number): IndexRow[] {
	if (ids.length === 0) return [];
	const found = exec(
		`SELECT e.id, e.folder_id, e.subject, e.sender, e.recipient, e.cc, e.bcc, e.date,
			e.read, e.starred, e.body, e.message_id, e.raw_headers,
			${normalizedSubjectSql("e.subject")} AS subject_norm,
			CASE
				WHEN e.folder_id = '${Folders.DRAFT}' THEN COALESCE(e.in_reply_to, e.id)
				WHEN e.thread_id IS NOT NULL THEN e.thread_id
				WHEN ${normalizedSubjectSql("e.subject")} = '' THEN e.id
				ELSE (
					SELECT MIN(COALESCE(o.thread_id, o.id)) FROM emails o
					WHERE o.folder_id != '${Folders.DRAFT}'
						AND ${normalizedSubjectSql("o.subject")} = ${normalizedSubjectSql("e.subject")}
				)
			END AS conversation_id,
			EXISTS (
				SELECT 1 FROM attachments a
				WHERE a.email_id = e.id AND COALESCE(a.disposition, 'attachment') != 'inline'
			) AS has_attachment,
			(SELECT json_group_array(label_id) FROM email_labels l WHERE l.email_id = e.id) AS labels
		FROM emails e
		WHERE e.id IN (SELECT value FROM json_each(?))`,
		JSON.stringify(ids),
	);
	const byId = new Map(found.map((row) => [String(row.id), row]));
	return ids.map((id) => {
		const row = byId.get(id);
		if (!row) return tombstone(id, seq);
		const sender = parseSender(row.sender as string | null, row.raw_headers as string | null);
		const bodyText = htmlToText(row.body as string | null);
		const list = listHeaders(row.raw_headers as string | null);
		return {
			email_id: id,
			seq,
			deleted: false,
			conversation_id: String(row.conversation_id ?? id),
			message_id: (row.message_id as string | null) ?? null,
			state: folderToState(String(row.folder_id)),
			date: String(row.date ?? ""),
			sender_addr: sender.addr,
			sender_name: sender.name,
			sender_domain: sender.domain,
			recipients: [row.recipient, row.cc, row.bcc].filter(Boolean).join(", ").toLowerCase(),
			subject: String(row.subject ?? ""),
			subject_norm: String(row.subject_norm ?? ""),
			snippet: bodyText.slice(0, SNIPPET_LENGTH),
			unread: !row.read,
			starred: !!row.starred,
			has_attachment: !!row.has_attachment,
			list_id: list.list_id,
			unsubscribe: list.unsubscribe,
			body_text: bodyText,
			labels: (JSON.parse(String(row.labels ?? "[]")) as string[]).sort(),
		};
	});
}

function tombstone(id: string, seq: number): IndexRow {
	return {
		email_id: id, seq, deleted: true, conversation_id: "", message_id: null, state: "", date: "",
		sender_addr: "", sender_name: "", sender_domain: "", recipients: "", subject: "", subject_norm: "",
		snippet: "", unread: false, starred: false, has_attachment: false, list_id: null, unsubscribe: null,
		body_text: "", labels: [],
	};
}

/** One rebuild page: emails after `afterId` in id order, stamped with the current seq. */
export function exportIndexRows(exec: Exec, options: { afterId?: string | null; limit?: number } = {}) {
	const limit = Math.min(Math.max(options.limit ?? EXPORT_LIMIT, 1), EXPORT_LIMIT);
	const ids = exec(`SELECT id FROM emails WHERE id > ? ORDER BY id LIMIT ?`, options.afterId ?? "", limit)
		.map((row) => String(row.id));
	const seq = currentSeq(exec);
	return {
		rows: buildIndexRows(exec, ids, seq),
		seq,
		nextAfterId: ids.length === limit ? ids[ids.length - 1] : null,
	};
}

export interface IndexCounts {
	states: Record<string, number>;
	unread: number;
	starred: number;
	total: number;
}

/** Message counts the parity page compares against the index. Unread counts the Inbox only. */
export function mailboxCounts(exec: Exec): IndexCounts {
	const states: Record<string, number> = {};
	let unread = 0;
	let starred = 0;
	let total = 0;
	for (const row of exec(
		`SELECT folder_id, COUNT(*) AS n, SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) AS unread,
			SUM(CASE WHEN starred = 1 THEN 1 ELSE 0 END) AS starred
		FROM emails GROUP BY folder_id`,
	)) {
		const state = folderToState(String(row.folder_id));
		states[state] = (states[state] ?? 0) + Number(row.n);
		if (state === Folders.INBOX) unread += Number(row.unread);
		starred += Number(row.starred);
		total += Number(row.n);
	}
	return { states, unread, starred, total };
}
