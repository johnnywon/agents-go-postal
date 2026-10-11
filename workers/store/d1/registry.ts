// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/** Mailboxes and their settings on D1 (was `mailboxes/<address>.json` in R2). */
import type { Sql } from "../sql";
import type { MailboxRegistry } from "../types";
import { SYSTEM_FOLDERS } from "./rows";

const FOLDER_NAMES: Record<string, string> = { inbox: "Inbox", sent: "Sent", draft: "Drafts", archive: "Archive", trash: "Trash", spam: "Spam" };

/** The mailbox row and its system folders, if they don't exist yet. */
export function ensureMailboxStatements(mailboxId: string) {
	return [
		{ sql: `INSERT OR IGNORE INTO mailboxes (id, created_at) VALUES (?, ?)`, params: [mailboxId, new Date().toISOString()] },
		...SYSTEM_FOLDERS.map((f) => ({
			sql: `INSERT OR IGNORE INTO folders (mailbox_id, id, name, is_deletable) VALUES (?, ?, ?, 0)`,
			params: [mailboxId, f, FOLDER_NAMES[f] ?? f],
		})),
	];
}

export function d1Registry(sql: Sql): MailboxRegistry {
	return {
		async list() {
			return (await sql.all(`SELECT id FROM mailboxes ORDER BY id`)).map((r) => ({ id: String(r.id), email: String(r.id) }));
		},
		async get(mailboxId) {
			const row = await sql.first(`SELECT settings FROM mailboxes WHERE id = ?`, mailboxId.toLowerCase());
			return row ? (JSON.parse(String(row.settings)) as Record<string, unknown>) : null;
		},
		async exists(mailboxId) {
			return !!(await sql.first(`SELECT 1 AS ok FROM mailboxes WHERE id = ?`, mailboxId.toLowerCase()));
		},
		async put(mailboxId, settings) {
			const id = mailboxId.toLowerCase();
			await sql.batch([
				...ensureMailboxStatements(id),
				{ sql: `UPDATE mailboxes SET settings = ? WHERE id = ?`, params: [JSON.stringify(settings), id] },
			]);
		},
	};
}
