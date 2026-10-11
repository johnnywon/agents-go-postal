import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTs, openDb } from "./helpers/sqlite.mjs";

const { applyMigrations, mailboxMigrations } = await loadTs("workers/durableObject/migrations.ts");
const rows = await loadTs("workers/lib/index-rows.ts");
const copy = await loadTs("workers/lib/copy-rows.ts");

function mailbox() {
	const handle = openDb();
	applyMigrations(handle.sqlStorage, mailboxMigrations, handle);
	return handle;
}

function insertEmail(exec, id, fields = {}) {
	const row = {
		id, folder_id: "inbox", subject: "Hello", sender: "ann@example.org", recipient: "me@example.com", date: "2026-10-01T00:00:00Z",
		read: 0, starred: 0, body: "<p>Body</p>", thread_id: null, ...fields,
	};
	const keys = Object.keys(row);
	exec(`INSERT INTO emails (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`, ...keys.map((k) => row[k]));
}

test("changes reach the copy outbox only while tracking", () => {
	const { exec } = mailbox();
	insertEmail(exec, "a");
	rows.recordChanges(exec, ["a"]);
	assert.equal(copy.pendingCopyChanges(exec), 0);
	assert.deepEqual(copy.startCopyTracking(exec), { total: 1 });
	rows.recordChanges(exec, ["a", "b"]);
	const { ids, seq } = copy.readCopyChanges(exec);
	assert.deepEqual(ids, ["a", "b"]);
	rows.recordChanges(exec, ["a"]); // a change after the read survives the ack
	copy.ackCopyChanges(exec, ids, seq);
	assert.deepEqual(copy.readCopyChanges(exec).ids, ["a"]);
	copy.stopCopyTracking(exec);
	assert.equal(copy.pendingCopyChanges(exec), 0);
	rows.recordChanges(exec, ["a"]);
	assert.equal(copy.pendingCopyChanges(exec), 0);
});

test("copy rows carry attachments, labels and the list's conversation", () => {
	const { exec } = mailbox();
	insertEmail(exec, "a", { subject: "Plans" });
	insertEmail(exec, "b", { subject: "Re: Plans" });
	exec(`INSERT INTO attachments (id, email_id, filename, mimetype, size) VALUES ('x', 'a', 'plan.pdf', 'application/pdf', 10)`);
	exec(`INSERT INTO email_labels (email_id, label_id) VALUES ('a', 'work'), ('a', 'home')`);
	const { rows: copied, missing } = copy.copyRows(exec, ["b", "a", "gone"]);
	assert.deepEqual(copied.map((r) => [r.id, r.conversation_id]), [["b", "a"], ["a", "a"]], "unthreaded mail groups by subject");
	assert.deepEqual(copied[1].labels, ["home", "work"]);
	assert.equal(copied[1].attachments[0].filename, "plan.pdf");
	assert.deepEqual(missing, ["gone"]);
});

test("a page stops at the byte cap but always takes one email", () => {
	const { exec } = mailbox();
	const big = "x".repeat(5 * 1024 * 1024);
	for (const id of ["a", "b", "c"]) insertEmail(exec, id, { body: big });
	const first = copy.copyPage(exec, null);
	assert.deepEqual(first.rows.map((r) => r.id), ["a"]);
	assert.equal(first.nextAfterId, "a");
	const pages = [first];
	while (pages.at(-1).nextAfterId) pages.push(copy.copyPage(exec, pages.at(-1).nextAfterId));
	assert.deepEqual(pages.map((p) => p.rows.map((r) => r.id)), [["a"], ["b"], ["c"]]);
	assert.deepEqual(copy.copyPage(exec, null, 2).rows.length, 1);
	insertEmail(exec, "d");
	assert.deepEqual(copy.copyPage(exec, "c").rows.map((r) => r.id), ["d"]);
	assert.equal(copy.copyPage(exec, "c").nextAfterId, null);
});
