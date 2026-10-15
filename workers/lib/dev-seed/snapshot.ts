// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

// A demo's hourly reset without writing the inbox again. Writing 100 messages
// with their search rows costs a few hundred milliseconds of Worker CPU, far
// past the Workers Free plan's 10 ms. So after a full write the reset copies the
// sample rows into demo_snapshot_* tables, and every later reset puts them back
// in one D1 batch: D1 does the copying, the Worker only sends the statements.
//
// The sample messages are never deleted, so their word and substring index rows
// stay. Only what visitors made goes, and their changes to sample rows are
// overwritten from the copy. A sample draft a visitor edited gets its index rows
// written again from the copy. Anything the copy can't put back (a sample
// message or file deleted for good, a new story week) makes the caller write the
// inbox in full and take a new copy.

import { ftsInsert, attachmentNames } from "../../store/d1/rows";
import { recordsSql } from "../../store";
import type { Statement } from "../../store/sql";
import type { Env } from "../../types";
import { htmlToText } from "../message-meta";

/** Tables the copy holds, parents before children. */
const COPIED = ["labels", "messages", "attachments", "message_labels", "label_auto", "draft_notes", "saved_searches"] as const;
/** Tables a reset empties: visitors' undo history, jobs and the activity log, which holds what they typed into Redraft. */
const CLEARED = ["undo", "bulk_job", "agent_activity", "auto_draft_runs", "scheduled_sends"] as const;
/** R2 prefixes the sample inbox writes. Anything else there was made by a visitor. */
const R2_PREFIXES = ["attachments/", "bodies/"] as const;
const META = "demo_snapshot_meta";
const snap = (table: string) => `demo_snapshot_${table}`;

export interface Restored {
	messages: number;
	labels: number;
	reindexed: number;
	removedFiles: number;
}

async function r2Keys(env: Env): Promise<string[]> {
	const keys: string[] = [];
	for (const prefix of R2_PREFIXES) {
		let cursor: string | undefined;
		do {
			const page = await env.BUCKET.list({ prefix, cursor, limit: 1000 });
			keys.push(...page.objects.map((o) => o.key));
			cursor = page.truncated ? page.cursor : undefined;
		} while (cursor);
	}
	return keys;
}

/** Copy the inbox as it is now. `key` names the story version the copy belongs to. */
export async function takeSnapshot(env: Env, key: string, now = Date.now()): Promise<void> {
	const sql = recordsSql(env);
	// Generated columns can't be written, so a restore names the others.
	const columns = (await sql.all<{ name: string; hidden: number }>("PRAGMA table_xinfo(messages)"))
		.filter((c) => Number(c.hidden) === 0 && c.name !== "id" && c.name !== "email_id")
		.map((c) => c.name);
	const statements: Statement[] = COPIED.flatMap((t) => [
		{ sql: `DROP TABLE IF EXISTS ${snap(t)}` },
		{ sql: `CREATE TABLE ${snap(t)} AS SELECT * FROM ${t}` },
	]);
	statements.push(
		{ sql: `CREATE TABLE IF NOT EXISTS ${META} (k TEXT PRIMARY KEY, v TEXT NOT NULL)` },
		{ sql: `DELETE FROM ${META}` },
		{ sql: `INSERT INTO ${META} (k, v) VALUES ('key', ?), ('taken_at', ?), ('columns', ?), ('files', ?)`, params: [key, String(now), JSON.stringify(columns), JSON.stringify(await r2Keys(env))] },
	);
	await sql.batch(statements);
}

/**
 * Put the copied inbox back. Returns null when the copy is missing, belongs to
 * another story version, or can't restore what visitors removed.
 * `shiftDates` moves the sample dates forward by the time since the copy.
 */
export async function restoreSnapshot(env: Env, key: string, opts: { now?: number; shiftDates?: boolean; maxAgeMs?: number } = {}): Promise<Restored | null> {
	const sql = recordsSql(env);
	const now = opts.now ?? Date.now();
	let meta: Record<string, string>;
	try {
		meta = Object.fromEntries((await sql.all<{ k: string; v: string }>(`SELECT k, v FROM ${META}`)).map((r) => [r.k, r.v]));
	} catch {
		return null; // No copy yet.
	}
	const takenAt = Number(meta.taken_at);
	if (meta.key !== key || !Number.isFinite(takenAt)) return null;
	if (opts.maxAgeMs !== undefined && now - takenAt > opts.maxAgeMs) return null;

	const [[counts], changed] = await sql.batch([
		{
			sql: `SELECT (SELECT COUNT(*) FROM ${snap("messages")}) AS copied,
				(SELECT COUNT(*) FROM messages WHERE email_id IN (SELECT email_id FROM ${snap("messages")})) AS present,
				(SELECT COUNT(*) FROM attachments WHERE id IN (SELECT id FROM ${snap("attachments")})) AS files,
				(SELECT COUNT(*) FROM ${snap("attachments")}) AS copiedFiles,
				(SELECT COUNT(*) FROM ${snap("labels")}) AS labels`,
		},
		// Sample messages whose indexed text a visitor changed (an edited sample draft).
		{
			sql: `SELECT m.id, s.email_id, s.subject, s.sender_name, s.sender_addr, s.recipients, s.body, s.body_key
				FROM messages m JOIN ${snap("messages")} s ON s.email_id = m.email_id
				WHERE m.subject IS NOT s.subject OR m.body IS NOT s.body OR m.body_key IS NOT s.body_key OR m.recipients IS NOT s.recipients`,
		},
	]);
	if (Number(counts.present) !== Number(counts.copied) || Number(counts.files) !== Number(counts.copiedFiles)) return null;

	const files = new Set<string>(JSON.parse(meta.files ?? "[]"));
	const live = await r2Keys(env);
	const liveSet = new Set(live);
	for (const f of files) if (!liveSet.has(f)) return null;

	const columns: string[] = JSON.parse(meta.columns ?? "[]");
	const assign = `(${columns.join(", ")}) = (${columns.map((c) => `s.${c}`).join(", ")})`;
	const statements: Statement[] = [
		// What visitors made. The delete triggers take their index rows with them.
		{ sql: `DELETE FROM messages WHERE email_id NOT IN (SELECT email_id FROM ${snap("messages")})` },
		{ sql: `UPDATE messages SET ${assign} FROM ${snap("messages")} AS s WHERE messages.email_id = s.email_id` },
		{ sql: `DELETE FROM message_labels` },
		{ sql: `DELETE FROM label_auto` },
		{ sql: `DELETE FROM draft_notes` },
		{ sql: `DELETE FROM saved_searches` },
		{ sql: `DELETE FROM attachments WHERE id NOT IN (SELECT id FROM ${snap("attachments")})` },
		{ sql: `DELETE FROM labels WHERE id NOT IN (SELECT id FROM ${snap("labels")})` },
		{ sql: `UPDATE labels SET (name, color, position) = (s.name, s.color, s.position) FROM ${snap("labels")} AS s WHERE labels.id = s.id` },
		{ sql: `INSERT OR IGNORE INTO labels SELECT * FROM ${snap("labels")}` },
		{ sql: `INSERT INTO message_labels SELECT * FROM ${snap("message_labels")}` },
		{ sql: `INSERT INTO label_auto SELECT * FROM ${snap("label_auto")}` },
		{ sql: `INSERT INTO draft_notes SELECT * FROM ${snap("draft_notes")}` },
		{ sql: `INSERT INTO saved_searches SELECT * FROM ${snap("saved_searches")}` },
		...CLEARED.map((t) => ({ sql: `DELETE FROM ${t}` })),
	];
	if (opts.shiftDates) {
		statements.push({
			sql: `UPDATE messages SET date = strftime('%Y-%m-%dT%H:%M:%fZ', julianday(date) + ? / 86400000.0)`,
			params: [now - takenAt],
		});
	}
	// An edited sample draft: its index rows hold the visitor's text. Write them again from the copy.
	for (const row of changed) {
		const body = row.body != null ? String(row.body) : row.body_key ? (await (await env.BUCKET.get(String(row.body_key)))?.text()) ?? "" : "";
		const names = attachmentNames(await sql.all<{ filename: string; disposition: string | null }>(`SELECT filename, disposition FROM ${snap("attachments")} WHERE email_id = ?`, row.email_id));
		const recipients = String(row.recipients ?? "");
		statements.push(
			{ sql: `DELETE FROM messages_fts WHERE rowid = ?`, params: [row.id] },
			{ sql: `DELETE FROM messages_trigram WHERE rowid = ?`, params: [row.id] },
			ftsInsert(String(row.email_id), {
				subject: String(row.subject ?? ""), senderName: String(row.sender_name ?? ""), senderAddr: String(row.sender_addr ?? ""),
				recipients, bodyText: htmlToText(body), attachmentNames: names,
			}),
			{
				sql: `INSERT INTO messages_trigram (rowid, subject, sender_addr, recipients, attachment_names) VALUES (?, ?, ?, ?, ?)`,
				params: [row.id, String(row.subject ?? ""), String(row.sender_addr ?? ""), recipients, names],
			},
		);
	}
	await sql.batch(statements);

	const extra = live.filter((k) => !files.has(k));
	for (let i = 0; i < extra.length; i += 1000) await env.BUCKET.delete(extra.slice(i, i + 1000));
	return { messages: Number(counts.copied), labels: Number(counts.labels), reindexed: changed.length, removedFiles: extra.length };
}
