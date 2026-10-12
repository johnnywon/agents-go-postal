import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTs, openDb } from "./helpers/sqlite.mjs";

const { applyMigrations, mailboxMigrations } = await loadTs("workers/durableObject/migrations.ts");
const bulk = await loadTs("workers/lib/mailbox-bulk.ts");
const meta = await loadTs("workers/lib/index-rows.ts");
const fi = await loadTs("workers/lib/folder-import.ts");

test("the dry run merges folders by name, reuses existing labels and totals counts", () => {
	const plan = fi.planFolderImport([
		{ mailboxId: "b@example.org", imported: false, folders: [{ folderId: "receipts", name: "Receipts", count: 3 }] },
		{ mailboxId: "a@example.com", imported: false, folders: [
			{ folderId: "receipts", name: "Receipts", count: 2 },
			{ folderId: "travel", name: "Travel", count: 0 },
			{ folderId: "tax", name: "Tax", count: 5 },
		] },
		{ mailboxId: "c@example.com", imported: false, folders: [] },
	], [{ id: "taxes", name: "tax" }, { id: "travel", name: "Trips" }]);

	assert.deepEqual(plan.totals, { mailboxes: 2, folders: 4, messages: 10 });
	assert.deepEqual(plan.mailboxes.map((m) => m.mailboxId), ["a@example.com", "b@example.org"]);
	assert.deepEqual(plan.labels, [
		{ id: "taxes", name: "tax", exists: true, folders: 1, messages: 5 },
		{ id: "receipts", name: "Receipts", exists: false, folders: 2, messages: 5 },
		{ id: "travel-2", name: "Travel", exists: false, folders: 1, messages: 0 },
	]);
	assert.equal(plan.mailboxes[0].folders.find((f) => f.folderId === "tax").labelId, "taxes");
});

/** A mailbox on node:sqlite exposing the MailboxDO import methods. */
function fakeMailbox() {
	const handle = openDb();
	applyMigrations(handle.sqlStorage, mailboxMigrations, handle);
	const { exec } = handle;
	exec(`INSERT INTO folders (id, name) VALUES ('receipts', 'Receipts')`);
	let n = 0;
	const add = (folder_id) => {
		const id = `e${++n}`;
		exec(`INSERT INTO emails (id, folder_id, subject, sender, recipient, date, body, thread_id) VALUES (?, ?, 's', 'x@y.z', 'a@example.com', '2026-10-01', '', ?)`, id, folder_id, id);
		return id;
	};
	return {
		exec, add,
		stub: {
			folderImportCounts: async () => ({ folders: bulk.customFolderCounts(exec), imported: bulk.foldersImported(exec) }),
			folderEmailIds: async (folderId) => bulk.folderEmailIdsSql(exec, folderId),
			importFolder: async (folderId, labelId) => ({
				labeled: bulk.importFolderLabelSql(exec, folderId, labelId).length,
				archived: bulk.importFolderArchiveSql(exec, folderId, labelId).length,
			}),
			markFoldersImported: async () => meta.setMeta(exec, "folders_imported", "1"),
		},
	};
}

function deps(box) {
	const labels = [];
	const backups = [];
	let t = Date.parse("2026-10-09T12:00:00Z");
	return {
		labels, backups,
		mailboxIds: async () => ["a@example.com"],
		mailbox: () => box.stub,
		listLabels: async () => labels.map((l) => ({ id: l.id, name: l.name, color: l.color })),
		createLabel: async (input) => (labels.push(input), { label: input }),
		putBackup: async (key, body) => void backups.push({ key, body: JSON.parse(body) }),
		now: () => (t += 1000),
	};
}

test("a run backs up, labels, archives and marks the mailbox; a rerun changes nothing", async () => {
	const box = fakeMailbox();
	const a = box.add("receipts");
	const b = box.add("receipts");
	const inbox = box.add("inbox");
	const d = deps(box);

	const dry = await fi.dryRunFolderImport(d);
	assert.deepEqual(dry.totals, { mailboxes: 1, folders: 1, messages: 2 });
	assert.equal(d.backups.length, 0);

	const first = await fi.runFolderImport(d);
	assert.match(first.backup, /^backups\/folder-import-2026-10-09T12-00-0\d-000Z\.json$/);
	assert.deepEqual(d.backups[0].body.emails, { "a@example.com": { receipts: [a, b] } });
	assert.deepEqual(d.labels.map((l) => [l.id, l.name, l.color]), [["receipts", "Receipts", "#c8372d"]]);
	assert.deepEqual(first.results.map((r) => [r.labeled, r.archived]), [[2, 2]]);
	assert.equal(box.exec(`SELECT folder_id FROM emails WHERE id = ?`, inbox)[0].folder_id, "inbox");
	assert.equal(bulk.foldersImported(box.exec), true);

	const second = await fi.runFolderImport(d);
	assert.deepEqual(second.results.map((r) => [r.labeled, r.archived]), [[0, 0]]);
	assert.equal(d.labels.length, 1);
	assert.equal(box.exec(`SELECT COUNT(*) AS n FROM folders WHERE id = 'receipts'`)[0].n, 1);
});

test("mail moved out of the folder before the run is left alone", async () => {
	const box = fakeMailbox();
	const kept = box.add("receipts");
	const moved = box.add("receipts");
	box.exec(`UPDATE emails SET folder_id = 'inbox' WHERE id = ?`, moved);
	const result = await fi.runFolderImport(deps(box));
	assert.deepEqual(result.results.map((r) => [r.labeled, r.archived]), [[1, 1]]);
	assert.equal(box.exec(`SELECT folder_id FROM emails WHERE id = ?`, kept)[0].folder_id, "archive");
	assert.equal(box.exec(`SELECT folder_id FROM emails WHERE id = ?`, moved)[0].folder_id, "inbox");
	assert.equal(Number(box.exec(`SELECT COUNT(*) AS n FROM email_labels WHERE email_id = ?`, moved)[0].n), 0);
});

test("new labels skip colours that existing labels use", async () => {
	const box = fakeMailbox();
	box.add("receipts");
	const d = deps(box);
	d.labels.push({ id: "follow-up", name: "Follow up", color: "#c8372d" });
	await fi.runFolderImport(d);
	assert.equal(d.labels.find((l) => l.id === "receipts").color, "#d9822b");
});
