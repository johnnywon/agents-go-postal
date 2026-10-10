// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Mailbox-side SQL for bulk actions, labels and the folder import. Runs
 * inside MailboxDO through the `Exec` adapter; each function returns the
 * email ids it changed so the caller can record them in the outbox.
 */

import { Folders } from "../../shared/folders";
import { getMeta } from "./index-rows";
import type { Exec } from "./sql-exec";

export const MAX_BULK_IDS = 100;
const SYSTEM_FOLDERS = new Set<string>(Object.values(Folders));

function idsJson(ids: string[]): string {
	if (ids.length > MAX_BULK_IDS) throw new Error(`A bulk call takes at most ${MAX_BULK_IDS} ids`);
	return JSON.stringify([...new Set(ids)]);
}

function column(rows: Record<string, unknown>[], key = "id"): string[] {
	return [...new Set(rows.map((row) => String(row[key])))];
}

export function isSystemFolder(folderId: string): boolean {
	return SYSTEM_FOLDERS.has(folderId);
}

/** True once this mailbox's custom folders were converted to labels. */
export function foldersImported(exec: Exec): boolean {
	return getMeta(exec, "folders_imported") === "1";
}

/** Set read and/or starred. Returns ids whose value changed. */
export function updateEmailsSql(exec: Exec, ids: string[], patch: { read?: boolean; starred?: boolean }): string[] {
	const json = idsJson(ids);
	const changed = new Set<string>();
	for (const key of ["read", "starred"] as const) {
		const value = patch[key];
		if (value === undefined) continue;
		const flag = value ? 1 : 0;
		for (const id of column(exec(
			`UPDATE emails SET ${key} = ? WHERE id IN (SELECT value FROM json_each(?)) AND ${key} != ? RETURNING id`,
			flag, json, flag,
		))) changed.add(id);
	}
	return [...changed];
}

/**
 * Move emails to a folder. With `from`, only rows still in that folder move,
 * so a stale plan or an undo never overrides a later change.
 */
export function moveEmailsSql(exec: Exec, ids: string[], to: string, from?: string): string[] {
	const json = idsJson(ids);
	if (!exec(`SELECT 1 FROM folders WHERE id = ?`, to)[0]) throw new Error(`Folder not found: ${to}`);
	if (!isSystemFolder(to) && foldersImported(exec)) {
		throw new Error("Moves go to system folders only; custom folders are labels now");
	}
	return column(from === undefined
		? exec(`UPDATE emails SET folder_id = ? WHERE id IN (SELECT value FROM json_each(?)) AND folder_id != ? RETURNING id`, to, json, to)
		: exec(
			`UPDATE emails SET folder_id = ? WHERE id IN (SELECT value FROM json_each(?)) AND folder_id = ? AND folder_id != ? RETURNING id`,
			to, json, from, to,
		));
}

/** Add and remove labels. Returns ids whose labels changed; ids that are not emails are skipped. */
export function setLabelsSql(exec: Exec, ids: string[], change: { add?: string[]; remove?: string[] }): string[] {
	const json = idsJson(ids);
	const changed = new Set<string>();
	for (const label of change.remove ?? []) {
		for (const id of column(exec(
			`DELETE FROM email_labels WHERE label_id = ? AND email_id IN (SELECT value FROM json_each(?)) RETURNING email_id`,
			label, json,
		), "email_id")) changed.add(id);
	}
	for (const label of change.add ?? []) {
		for (const id of column(exec(
			`INSERT OR IGNORE INTO email_labels (email_id, label_id)
			SELECT e.id, ? FROM emails e WHERE e.id IN (SELECT value FROM json_each(?))
			RETURNING email_id`,
			label, json,
		), "email_id")) changed.add(id);
	}
	return [...changed];
}

/** Custom folders with their message counts, for the folder import dry run. */
export function customFolderCounts(exec: Exec): { folderId: string; name: string; count: number }[] {
	return exec(
		`SELECT f.id AS folderId, f.name AS name, COUNT(e.id) AS count
		FROM folders f LEFT JOIN emails e ON e.folder_id = f.id
		WHERE f.id NOT IN (SELECT value FROM json_each(?))
		GROUP BY f.id, f.name ORDER BY f.id`,
		JSON.stringify([...SYSTEM_FOLDERS]),
	).map((r) => ({ folderId: String(r.folderId), name: String(r.name), count: Number(r.count) }));
}

export function folderEmailIdsSql(exec: Exec, folderId: string): string[] {
	return column(exec(`SELECT id FROM emails WHERE folder_id = ? ORDER BY id`, folderId));
}

/** Import step 1: give every email in the folder the label. Returns newly labeled ids. */
export function importFolderLabelSql(exec: Exec, folderId: string, labelId: string): string[] {
	return column(exec(
		`INSERT OR IGNORE INTO email_labels (email_id, label_id)
		SELECT id, ? FROM emails WHERE folder_id = ? RETURNING email_id`,
		labelId, folderId,
	), "email_id");
}

/** Import step 2: move labeled mail that is still in the folder to Archive. The folder itself stays. */
export function importFolderArchiveSql(exec: Exec, folderId: string, labelId: string): string[] {
	return column(exec(
		`UPDATE emails SET folder_id = ? WHERE folder_id = ?
			AND id IN (SELECT email_id FROM email_labels WHERE label_id = ?)
		RETURNING id`,
		Folders.ARCHIVE, folderId, labelId,
	));
}

export interface PurgedAttachment {
	emailId: string;
	id: string;
	filename: string;
}

/**
 * Empty Trash: permanently delete the given emails if they are still in
 * Trash. Returns the deleted ids and the attachments whose R2 blobs the
 * caller removes. Attachment rows and labels go by ON DELETE CASCADE.
 */
export function purgeTrashSql(exec: Exec, ids: string[]): { deleted: string[]; attachments: PurgedAttachment[] } {
	const json = idsJson(ids);
	const attachments = exec(
		`SELECT a.email_id, a.id, a.filename FROM attachments a JOIN emails e ON e.id = a.email_id
		WHERE e.folder_id = ? AND e.id IN (SELECT value FROM json_each(?)) ORDER BY a.email_id, a.id`,
		Folders.TRASH, json,
	).map((r) => ({ emailId: String(r.email_id), id: String(r.id), filename: String(r.filename) }));
	const deleted = column(exec(
		`DELETE FROM emails WHERE folder_id = ? AND id IN (SELECT value FROM json_each(?)) RETURNING id`,
		Folders.TRASH, json,
	));
	return { deleted, attachments };
}
