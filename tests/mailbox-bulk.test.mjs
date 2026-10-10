import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTs, openDb } from "./helpers/sqlite.mjs";

const { applyMigrations, mailboxMigrations } = await loadTs("workers/durableObject/migrations.ts");
const bulk = await loadTs("workers/lib/mailbox-bulk.ts");
const meta = await loadTs("workers/lib/index-rows.ts");

function mailbox() {
	const handle = openDb();
	applyMigrations(handle.sqlStorage, mailboxMigrations, handle);
	handle.exec(`INSERT OR IGNORE INTO folders (id, name, is_deletable) VALUES ('spam', 'Spam', 0)`);
	return handle;
}

let n = 0;
function insertEmail(exec, fields = {}) {
	const id = fields.id ?? `e${String(++n).padStart(4, "0")}`;
	const row = {
		id, folder_id: "inbox", subject: "Hello", sender: "ann@example.org", recipient: "me@wayne.org",
		date: "2026-10-01T00:00:00Z", read: 0, starred: 0, body: "<p>Body</p>", thread_id: id, ...fields,
	};
	const keys = Object.keys(row);
	exec(`INSERT INTO emails (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`, ...keys.map((k) => row[k]));
	return id;
}

const folderOf = (exec, id) => exec(`SELECT folder_id FROM emails WHERE id = ?`, id)[0]?.folder_id;
const labelsOf = (exec, id) => exec(`SELECT label_id FROM email_labels WHERE email_id = ? ORDER BY label_id`, id).map((r) => r.label_id);

test("updateEmailsSql returns only rows whose value changed", () => {
	const { exec } = mailbox();
	const a = insertEmail(exec, { read: 0 });
	const b = insertEmail(exec, { read: 1 });
	assert.deepEqual(bulk.updateEmailsSql(exec, [a, b, "missing"], { read: true }).sort(), [a]);
	assert.deepEqual(bulk.updateEmailsSql(exec, [a, b], { starred: true }).sort(), [a, b].sort());
	assert.deepEqual(bulk.updateEmailsSql(exec, [a], {}), []);
	assert.throws(() => bulk.updateEmailsSql(exec, Array.from({ length: 101 }, (_, i) => `x${i}`), { read: true }), /at most 100/);
});

test("moveEmailsSql moves only rows still in the source folder", () => {
	const { exec } = mailbox();
	const a = insertEmail(exec);
	const b = insertEmail(exec, { folder_id: "sent" });
	assert.deepEqual(bulk.moveEmailsSql(exec, [a, b], "archive", "inbox"), [a]);
	assert.equal(folderOf(exec, a), "archive");
	assert.equal(folderOf(exec, b), "sent");
	assert.deepEqual(bulk.moveEmailsSql(exec, [b], "archive"), [b]);
	assert.throws(() => bulk.moveEmailsSql(exec, [a], "nowhere"), /Folder not found/);
});

test("after a folder import, moves into custom folders are refused", () => {
	const { exec } = mailbox();
	exec(`INSERT INTO folders (id, name) VALUES ('receipts', 'Receipts')`);
	const a = insertEmail(exec);
	assert.deepEqual(bulk.moveEmailsSql(exec, [a], "receipts"), [a]);
	meta.setMeta(exec, "folders_imported", "1");
	assert.equal(bulk.foldersImported(exec), true);
	assert.throws(() => bulk.moveEmailsSql(exec, [a], "receipts"), /system folders only/);
	assert.deepEqual(bulk.moveEmailsSql(exec, [a], "inbox"), [a]);
});

test("setLabelsSql adds idempotently, removes, and skips unknown ids", () => {
	const { exec } = mailbox();
	const a = insertEmail(exec);
	const b = insertEmail(exec);
	assert.deepEqual(bulk.setLabelsSql(exec, [a, b, "missing"], { add: ["tax"] }).sort(), [a, b].sort());
	assert.deepEqual(bulk.setLabelsSql(exec, [a, b], { add: ["tax"] }), []);
	assert.deepEqual(bulk.setLabelsSql(exec, [a], { add: ["work"], remove: ["tax"] }), [a]);
	assert.deepEqual(labelsOf(exec, a), ["work"]);
	assert.deepEqual(labelsOf(exec, b), ["tax"]);
	assert.equal(Number(exec(`SELECT COUNT(*) AS n FROM email_labels WHERE email_id = 'missing'`)[0].n), 0);
});

test("customFolderCounts lists custom folders only, empty ones included", () => {
	const { exec } = mailbox();
	exec(`INSERT INTO folders (id, name) VALUES ('receipts', 'Receipts'), ('empty', 'Empty')`);
	insertEmail(exec, { folder_id: "receipts" });
	insertEmail(exec, { folder_id: "receipts" });
	insertEmail(exec);
	assert.deepEqual(bulk.customFolderCounts(exec), [
		{ folderId: "empty", name: "Empty", count: 0 },
		{ folderId: "receipts", name: "Receipts", count: 2 },
	]);
});

test("importFolderSql labels, then archives only labeled mail still in the folder; reruns do nothing", () => {
	const { exec } = mailbox();
	exec(`INSERT INTO folders (id, name) VALUES ('receipts', 'Receipts')`);
	const a = insertEmail(exec, { folder_id: "receipts" });
	const b = insertEmail(exec, { folder_id: "receipts" });
	const other = insertEmail(exec);

	const labeled = bulk.importFolderLabelSql(exec, "receipts", "receipts");
	assert.deepEqual(labeled.sort(), [a, b].sort());
	const archived = bulk.importFolderArchiveSql(exec, "receipts", "receipts");
	assert.deepEqual(archived.sort(), [a, b].sort());
	assert.equal(folderOf(exec, a), "archive");
	assert.deepEqual(labelsOf(exec, other), []);

	assert.deepEqual(bulk.importFolderLabelSql(exec, "receipts", "receipts"), []);
	assert.deepEqual(bulk.importFolderArchiveSql(exec, "receipts", "receipts"), []);
	assert.equal(exec(`SELECT COUNT(*) AS n FROM folders WHERE id = 'receipts'`)[0].n, 1);
});

test("purgeTrashSql deletes only mail still in Trash and returns its attachments", () => {
	const { exec } = mailbox();
	const t1 = insertEmail(exec, { folder_id: "trash" });
	const t2 = insertEmail(exec, { folder_id: "trash" });
	const i1 = insertEmail(exec);
	const d1 = insertEmail(exec, { folder_id: "draft" });
	exec(`INSERT INTO attachments (id, email_id, filename, mimetype, size, disposition) VALUES ('a1', ?, 'x.pdf', 'application/pdf', 3, 'attachment')`, t1);
	exec(`INSERT INTO email_labels (email_id, label_id) VALUES (?, 'tax')`, t1);
	const out = bulk.purgeTrashSql(exec, [t1, t2, i1, d1, "missing"]);
	assert.deepEqual(out.deleted.sort(), [t1, t2].sort());
	assert.deepEqual(out.attachments, [{ emailId: t1, id: "a1", filename: "x.pdf" }]);
	assert.deepEqual(exec(`SELECT id FROM emails ORDER BY id`).map((r) => r.id), [i1, d1].sort());
	assert.equal(exec(`SELECT COUNT(*) AS n FROM attachments`)[0].n, 0);
	assert.equal(exec(`SELECT COUNT(*) AS n FROM email_labels`)[0].n, 0);
	assert.deepEqual(bulk.purgeTrashSql(exec, [t1]), { deleted: [], attachments: [] });
	assert.throws(() => bulk.purgeTrashSql(exec, Array.from({ length: 101 }, (_, i) => `x${i}`)), /at most 100/);
});
