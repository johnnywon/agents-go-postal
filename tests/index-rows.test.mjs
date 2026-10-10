import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTs, openDb } from "./helpers/sqlite.mjs";

const { applyMigrations, mailboxMigrations } = await loadTs("workers/durableObject/migrations.ts");
const rows = await loadTs("workers/lib/index-rows.ts");

function mailbox() {
	const handle = openDb();
	applyMigrations(handle.sqlStorage, mailboxMigrations, handle);
	return handle;
}

let n = 0;
function insertEmail(exec, fields = {}) {
	const id = fields.id ?? `e${String(++n).padStart(4, "0")}`;
	const row = {
		id, folder_id: "inbox", subject: "Hello", sender: "ann@example.org", recipient: "me@wayne.org", cc: null, bcc: null,
		date: "2026-10-01T00:00:00Z", read: 0, starred: 0, body: "<p>Body</p>", in_reply_to: null, email_references: null,
		thread_id: id, message_id: `${id}@mail`, raw_headers: null, ...fields,
	};
	const keys = Object.keys(row);
	exec(`INSERT INTO emails (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`, ...keys.map((k) => row[k]));
	return id;
}

test("migration 9 creates the outbox, meta and labels tables and is idempotent", () => {
	const { exec, sqlStorage, transactionSync } = mailbox();
	applyMigrations(sqlStorage, mailboxMigrations, { transactionSync });
	assert.equal(rows.currentSeq(exec), 0);
	const tables = exec(`SELECT name FROM sqlite_master WHERE type = 'table'`).map((r) => r.name);
	for (const name of ["index_outbox", "index_meta", "email_labels"]) assert.ok(tables.includes(name), name);
});

test("recordChanges bumps seq once per call and writes one row per distinct id", () => {
	const { exec } = mailbox();
	assert.equal(rows.recordChanges(exec, ["a", "b", "a"]), 1);
	assert.equal(rows.recordChanges(exec, ["a"]), 2);
	assert.equal(rows.recordChanges(exec, []), 2);
	assert.deepEqual(exec(`SELECT seq, email_id FROM index_outbox ORDER BY seq, email_id`), [
		{ seq: 1, email_id: "a" }, { seq: 1, email_id: "b" }, { seq: 2, email_id: "a" },
	]);
	assert.equal(rows.pendingCount(exec), 2);
});

test("readOutbox returns current state stamped with the current seq, and ack keeps later changes", () => {
	const { exec } = mailbox();
	const id = insertEmail(exec);
	rows.recordChanges(exec, [id, "gone"]);
	const batch = rows.readOutbox(exec);
	assert.equal(batch.seq, 1);
	assert.deepEqual(batch.rows.map((r) => [r.email_id, r.deleted, r.seq]), [[id, false, 1], ["gone", true, 1]]);
	rows.recordChanges(exec, [id]);
	rows.ackOutbox(exec, batch.rows.map((r) => r.email_id), batch.seq);
	assert.deepEqual(exec(`SELECT seq, email_id FROM index_outbox`), [{ seq: 2, email_id: id }]);
});

test("readOutbox caps a batch at 99 emails, oldest change first", () => {
	const { exec } = mailbox();
	for (let i = 0; i < 120; i++) rows.recordChanges(exec, [`m${String(i).padStart(3, "0")}`]);
	const batch = rows.readOutbox(exec, 500);
	assert.equal(batch.rows.length, 99);
	assert.equal(batch.rows[0].email_id, "m000");
});

test("buildIndexRows fills metadata from the stored email", () => {
	const { exec } = mailbox();
	const id = insertEmail(exec, {
		folder_id: "archive", subject: "Re: Invoice", read: 1, starred: 1, cc: "Bob@x.dev",
		body: "<style>x{}</style><p>Paid &amp; done</p>",
		raw_headers: JSON.stringify([
			{ key: "from", value: '"Ann" <ann@example.org>' },
			{ key: "list-unsubscribe", value: "<https://example.org/u>" },
		]),
	});
	exec(`INSERT INTO attachments (id, email_id, filename, mimetype, size, disposition) VALUES ('a1', ?, 'f.pdf', 'application/pdf', 1, 'attachment')`, id);
	exec(`INSERT INTO email_labels (email_id, label_id) VALUES (?, 'l2'), (?, 'l1')`, id, id);
	const [row] = rows.buildIndexRows(exec, [id], 7);
	assert.deepEqual(
		{ ...row, body_text: undefined },
		{
			email_id: id, seq: 7, deleted: false, conversation_id: id, message_id: `${id}@mail`, state: "archive",
			date: "2026-10-01T00:00:00Z", sender_addr: "ann@example.org", sender_name: "Ann", sender_domain: "example.org",
			recipients: "me@wayne.org, bob@x.dev", subject: "Re: Invoice", subject_norm: "invoice", snippet: "Paid & done",
			unread: false, starred: true, has_attachment: true, list_id: null,
			unsubscribe: JSON.stringify({ urls: ["https://example.org/u"], oneClick: false }),
			body_text: undefined, labels: ["l1", "l2"],
		},
	);
});

test("inline attachments do not count, custom folders map to folder:<id>", () => {
	const { exec } = mailbox();
	exec(`INSERT INTO folders (id, name) VALUES ('receipts', 'Receipts')`);
	const id = insertEmail(exec, { folder_id: "receipts" });
	exec(`INSERT INTO attachments (id, email_id, filename, mimetype, size, disposition) VALUES ('a1', ?, 'logo.png', 'image/png', 1, 'inline')`, id);
	const [row] = rows.buildIndexRows(exec, [id], 1);
	assert.equal(row.state, "folder:receipts");
	assert.equal(row.has_attachment, false);
});

test("conversation ids: thread id, draft reply target, and legacy subject fallback", () => {
	const { exec } = mailbox();
	const threaded = insertEmail(exec, { thread_id: "t-1" });
	const draft = insertEmail(exec, { folder_id: "draft", thread_id: "t-1", in_reply_to: threaded });
	const newDraft = insertEmail(exec, { folder_id: "draft", thread_id: null });
	const legacyA = insertEmail(exec, { id: "z-legacy-a", thread_id: null, subject: "Lunch" });
	const legacyB = insertEmail(exec, { id: "a-legacy-b", thread_id: null, subject: "RE: lunch", folder_id: "archive" });
	const blank = insertEmail(exec, { id: "blank-1", thread_id: null, subject: "" });
	const byId = Object.fromEntries(rows.buildIndexRows(exec, [threaded, draft, newDraft, legacyA, legacyB, blank], 1).map((r) => [r.email_id, r.conversation_id]));
	assert.equal(byId[threaded], "t-1");
	assert.equal(byId[draft], threaded);
	assert.equal(byId[newDraft], newDraft);
	assert.equal(byId[legacyA], "a-legacy-b");
	assert.equal(byId[legacyB], "a-legacy-b");
	assert.equal(byId[blank], "blank-1");
});

test("exportIndexRows pages by id with the current seq and caps the limit", () => {
	const { exec } = mailbox();
	const ids = Array.from({ length: 5 }, () => insertEmail(exec)).sort();
	rows.recordChanges(exec, ["x"]);
	const first = rows.exportIndexRows(exec, { limit: 3 });
	assert.deepEqual(first.rows.map((r) => r.email_id), ids.slice(0, 3));
	assert.equal(first.seq, 1);
	assert.equal(first.nextAfterId, ids[2]);
	const second = rows.exportIndexRows(exec, { afterId: first.nextAfterId, limit: 3 });
	assert.deepEqual(second.rows.map((r) => r.email_id), ids.slice(3));
	assert.equal(second.nextAfterId, null);
	assert.ok(rows.exportIndexRows(exec, { limit: 1000 }).rows.length <= 100);
});

test("mailboxCounts reports per-state counts, inbox unread and starred", () => {
	const { exec } = mailbox();
	insertEmail(exec, { read: 0 });
	insertEmail(exec, { read: 1, starred: 1 });
	insertEmail(exec, { folder_id: "archive", read: 0, starred: 1 });
	assert.deepEqual(rows.mailboxCounts(exec), { states: { inbox: 2, archive: 1 }, unread: 1, starred: 2, total: 3 });
});
