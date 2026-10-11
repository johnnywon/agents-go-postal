// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Write side of the copy from the Durable Objects (store/copy-job.ts). Every
 * write replaces or diffs, so a page or pass that runs twice changes nothing.
 */
import type { CopyAttachment, CopyCounts, CopyMeta, CopyRow } from "../../lib/copy-rows";
import { chunkByBytes, type Sql, type Statement } from "../sql";
import { ensureMailboxStatements } from "./registry";
import { BODY_INLINE_MAX, bodyKey, insertStatements } from "./rows";

export interface CopyGlobals {
	labels: Record<string, unknown>[];
	labelAuto: Record<string, unknown>[];
	savedSearches: Record<string, unknown>[];
}

const bytes = (text: string) => new TextEncoder().encode(text).length;

/** Replace these messages with the rows given, and delete the `missing` ones. */
export async function writeCopyRows(sql: Sql, bucket: R2Bucket, mailboxId: string, rows: CopyRow[], missing: string[] = []) {
	const statements: Statement[] = [];
	if (missing.length > 0) {
		statements.push({ sql: `DELETE FROM messages WHERE mailbox_id = ? AND email_id IN (SELECT value FROM json_each(?))`, params: [mailboxId, JSON.stringify(missing)] });
	}
	for (const row of rows) {
		const bodyInR2 = bytes(row.body) > BODY_INLINE_MAX;
		if (bodyInR2) await bucket.put(bodyKey(row.id), row.body, { httpMetadata: { contentType: "text/html" } });
		statements.push(
			// Cascades to attachments, labels and search rows.
			{ sql: `DELETE FROM messages WHERE mailbox_id = ? AND email_id = ?`, params: [mailboxId, row.id] },
			...insertStatements(mailboxId, row.folder_id, row, row.attachments.map(attachmentInput), row.conversation_id, { bodyInR2 }),
			...row.labels.map((label) => ({
				// Skips label ids the index no longer has.
				sql: `INSERT OR IGNORE INTO message_labels (message, label_id) SELECT m.id, l.id FROM messages m JOIN labels l ON l.id = ? WHERE m.email_id = ?`,
				params: [label, row.id],
			})),
		);
	}
	for (const chunk of chunkByBytes(statements)) await sql.batch(chunk);
}

function attachmentInput(a: CopyAttachment) {
	return { id: a.id, email_id: a.email_id, filename: a.filename, mimetype: a.mimetype, size: a.size, content_id: a.content_id, disposition: a.disposition };
}

/** The mailbox row, its settings and its custom folders. Runs before its messages, which reference the folders. */
export async function writeCopySetup(sql: Sql, mailboxId: string, settings: Record<string, unknown> | null, meta: CopyMeta) {
	await sql.batch([
		...ensureMailboxStatements(mailboxId),
		{
			sql: `UPDATE mailboxes SET settings = ?, folders_imported = ? WHERE id = ? AND (settings != ? OR folders_imported != ?)`,
			params: [JSON.stringify(settings ?? {}), meta.foldersImported ? 1 : 0, mailboxId, JSON.stringify(settings ?? {}), meta.foldersImported ? 1 : 0],
		},
		...meta.folders.map((f) => ({
			sql: `INSERT INTO folders (mailbox_id, id, name, is_deletable) VALUES (?, ?, ?, ?)
				ON CONFLICT (mailbox_id, id) DO UPDATE SET name = excluded.name, is_deletable = excluded.is_deletable
				WHERE name != excluded.name OR is_deletable != excluded.is_deletable`,
			params: [mailboxId, f.id, f.name, f.is_deletable],
		})),
	]);
}

/**
 * Make D1's scheduled sends and send keys match the mailbox's. A D1 row is
 * removed only when its draft came from the mailbox (`fromMailbox`), so
 * mail scheduled on D1 after cutover survives the final pass.
 */
export async function writeCopyScheduled(sql: Sql, mailboxId: string, meta: CopyMeta, fromMailbox: (ids: string[]) => Promise<Set<string>>) {
	const wanted = new Set(meta.scheduled.map((s) => s.email_id));
	const present = (await sql.all(`SELECT email_id FROM scheduled_sends WHERE mailbox_id = ?`, mailboxId)).map((r) => String(r.email_id));
	const extra = present.filter((id) => !wanted.has(id));
	const drop = extra.length > 0 ? [...(await fromMailbox(extra))] : [];
	const statements: Statement[] = [];
	if (drop.length > 0) {
		statements.push({ sql: `DELETE FROM scheduled_sends WHERE mailbox_id = ? AND email_id IN (SELECT value FROM json_each(?))`, params: [mailboxId, JSON.stringify(drop)] });
	}
	for (const s of meta.scheduled) {
		statements.push({
			// Only for a draft that was copied; the cascade from messages keeps the two in step.
			sql: `INSERT INTO scheduled_sends (email_id, mailbox_id, send_at, payload, attempts, error)
				SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM messages WHERE mailbox_id = ? AND email_id = ?)
				ON CONFLICT (email_id) DO UPDATE SET send_at = excluded.send_at, payload = excluded.payload, attempts = excluded.attempts, error = excluded.error
				WHERE send_at != excluded.send_at OR payload != excluded.payload OR attempts != excluded.attempts OR error IS NOT excluded.error`,
			params: [s.email_id, mailboxId, s.send_at, s.payload, s.attempts, s.error, mailboxId, s.email_id],
		});
	}
	for (const k of meta.sendKeys) {
		statements.push({
			sql: `INSERT INTO send_keys (mailbox_id, key, state, email_id, created_at) VALUES (?, ?, ?, ?, ?)
				ON CONFLICT (mailbox_id, key) DO UPDATE SET state = excluded.state, email_id = excluded.email_id
				WHERE state != excluded.state OR email_id IS NOT excluded.email_id`,
			params: [mailboxId, k.key, k.state, k.email_id, k.created_at],
		});
	}
	for (const chunk of chunkByBytes(statements)) await sql.batch(chunk);
}

/**
 * Labels, auto-label flags and saved searches. With `prune`, rows gone from
 * the index are deleted too (a label with its message labels).
 */
export async function writeCopyGlobals(sql: Sql, globals: CopyGlobals, options: { prune: boolean }) {
	const ids = (rows: Record<string, unknown>[], key = "id") => JSON.stringify(rows.map((r) => String(r[key])));
	const prune = (table: string, column: string, rows: Record<string, unknown>[], key = "id"): Statement[] =>
		options.prune ? [{ sql: `DELETE FROM ${table} WHERE ${column} NOT IN (SELECT value FROM json_each(?))`, params: [ids(rows, key)] }] : [];
	const statements: Statement[] = [
		...prune("labels", "id", globals.labels),
		...globals.labels.map((l) => ({
			sql: `INSERT INTO labels (id, name, color, position) VALUES (?, ?, ?, ?)
				ON CONFLICT (id) DO UPDATE SET name = excluded.name, color = excluded.color, position = excluded.position
				WHERE name != excluded.name OR color != excluded.color OR position != excluded.position`,
			params: [l.id, l.name, l.color, l.position ?? 0],
		})),
		...prune("label_auto", "label_id", globals.labelAuto, "label_id"),
		...globals.labelAuto.map((a) => ({
			sql: `INSERT INTO label_auto (label_id, applied_at) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM labels WHERE id = ?)
				ON CONFLICT (label_id) DO UPDATE SET applied_at = excluded.applied_at WHERE applied_at != excluded.applied_at`,
			params: [a.label_id, a.applied_at, a.label_id],
		})),
		...prune("saved_searches", "id", globals.savedSearches),
		...globals.savedSearches.map((s) => ({
			sql: `INSERT INTO saved_searches (id, name, filter, position) VALUES (?, ?, ?, ?)
				ON CONFLICT (id) DO UPDATE SET name = excluded.name, filter = excluded.filter, position = excluded.position
				WHERE name != excluded.name OR filter != excluded.filter OR position != excluded.position`,
			params: [s.id, s.name, s.filter, s.position ?? 0],
		})),
	];
	for (const chunk of chunkByBytes(statements)) await sql.batch(chunk);
}

/** The same counts as the mailbox's copyCounts, from D1. */
export async function d1CopyCounts(sql: Sql, mailboxId: string): Promise<CopyCounts> {
	const [stateRows, labelRows, attachmentRows, scheduledRows] = await sql.batch([
		{
			sql: `SELECT state, COUNT(*) AS n, SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) AS unread, SUM(CASE WHEN starred = 1 THEN 1 ELSE 0 END) AS starred
				FROM messages WHERE mailbox_id = ? GROUP BY state`,
			params: [mailboxId],
		},
		{ sql: `SELECT ml.label_id, COUNT(*) AS n FROM message_labels ml JOIN messages m ON m.id = ml.message WHERE m.mailbox_id = ? GROUP BY ml.label_id`, params: [mailboxId] },
		{ sql: `SELECT COUNT(*) AS n FROM attachments a JOIN messages m ON m.email_id = a.email_id WHERE m.mailbox_id = ?`, params: [mailboxId] },
		{ sql: `SELECT COUNT(*) AS n FROM scheduled_sends WHERE mailbox_id = ?`, params: [mailboxId] },
	]);
	const states: CopyCounts["states"] = {};
	for (const r of stateRows) states[String(r.state)] = { total: Number(r.n), unread: Number(r.unread), starred: Number(r.starred) };
	const labels: Record<string, number> = {};
	for (const r of labelRows) labels[String(r.label_id)] = Number(r.n);
	return { states, labels, attachments: Number(attachmentRows[0]?.n ?? 0), scheduled: Number(scheduledRows[0]?.n ?? 0) };
}
