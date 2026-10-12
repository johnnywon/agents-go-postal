import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { statements } from "./helpers/schema.mjs";
import { D1_SCHEMA } from "./helpers/d1-schema.mjs";

// One script of store calls against the Durable Object store and the D1 store.
// Both must return the same results, so callers can't tell them apart.

const A = "a@example.com";
const B = "b@example.org";
const SCHEMA = D1_SCHEMA;
let mf;

before(async () => {
	const bundle = await build({
		entryPoints: ["tests/fixtures/store-worker.ts"], bundle: true, format: "esm", platform: "neutral",
		conditions: ["workerd", "worker", "browser"], mainFields: ["module", "main"], external: ["cloudflare:workers"],
		write: false, logLevel: "silent",
	});
	mf = new Miniflare({
		modules: true,
		script: bundle.outputFiles[0].text,
		compatibilityDate: "2025-11-28",
		compatibilityFlags: ["nodejs_compat"],
		bindings: { EMAIL_ADDRESSES: [A, B], INDEX_SYNC_ENABLED: "true" },
		r2Buckets: ["BUCKET"],
		d1Databases: ["DB"],
		durableObjects: {
			MAILBOX: { className: "MailboxDO", useSQLite: true },
			MAIL_INDEX: { className: "MailIndexDO", useSQLite: true },
		},
	});
	for (const s of statements(SCHEMA)) await raw("d1", "-", "_sql", s);
	const bucket = await mf.getR2Bucket("BUCKET");
	for (const m of [A, B]) {
		await bucket.put(`mailboxes/${m}.json`, "{}");
		await raw("do", m, "_teach");
	}
});

after(async () => {
	await mf?.dispose();
});

async function raw(store, target, op, ...args) {
	const response = await mf.dispatchFetch("http://test/", { method: "POST", body: JSON.stringify({ store, target, op, args }) });
	return response.json();
}

/** Run one call on both stores; returns [do, d1] results (or errors). */
async function both(target, op, ...args) {
	const results = [];
	for (const store of ["do", "d1"]) {
		const r = await raw(store, target, op, ...args);
		results.push(r.error !== undefined ? { error: r.error } : r.ok);
	}
	return results;
}

/** Same call on both stores, results equal after `normalize`. */
async function same(label, target, op, args = [], normalize = (x) => x) {
	const [a, b] = await both(target, op, ...args);
	assert.deepEqual(normalize(b), normalize(a), `${label}: D1 differs from the Durable Object store`);
	return a;
}

const hoursAgo = (h) => new Date(Date.now() - h * 3_600_000).toISOString();
const email = (id, fields = {}) => ({
	id, subject: "Hello", sender: "ann@example.net", recipient: A, cc: null, bcc: null, date: hoursAgo(1),
	body: "<p>Hello there</p>", thread_id: id, message_id: `${id}@example.net`, raw_headers: JSON.stringify([{ key: "from", value: "Ann <ann@example.net>" }]),
	...fields,
});

// Fields that legitimately differ between stores.
const dropSnippet = (rows) => (Array.isArray(rows) ? rows.map(({ snippet, ...rest }) => rest) : rows);
// Each store gives a scheduled draft its own random id.
const uuid = (v) => (typeof v === "string" ? v.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "uuid") : v);
const pageKeys = (page) => page?.conversations?.map((c) => ({
	key: uuid(c.thread_key), email: uuid(c.email_id), count: c.thread_count, unread: c.thread_unread_count, labels: c.labels, state: c.state, starred: c.starred,
})) ?? page;
const noUndoId = (r) => (r && typeof r === "object" ? { ...r, undoId: r.undoId ? "id" : r.undoId } : r);

test("storing and reading mail", async () => {
	await same("store inbox", A, "createEmail", ["inbox", email("e1", { subject: "Invoice October", body: "<p>Your invoice is attached</p>" }), [
		{ id: "att1", email_id: "e1", filename: "invoice.pdf", mimetype: "application/pdf", size: 1200, content_id: null, disposition: "attachment" },
	]]);
	await same("store reply", A, "createEmail", ["sent", email("e2", { subject: "Re: Invoice October", sender: A, recipient: "ann@example.net", thread_id: "e1", in_reply_to: "e1@example.net", date: hoursAgo(0.5) }), []]);
	await same("store newsletter", A, "createEmail", ["inbox", email("e3", { subject: "Weekly digest", sender: "news@example.net", date: hoursAgo(30), raw_headers: JSON.stringify([{ key: "list-id", value: "<news.example.net>" }]) }), []]);
	await same("store other address", B, "createEmail", ["inbox", email("e4", { subject: "Lunch", recipient: B, date: hoursAgo(2) }), []]);
	await same("store draft", A, "createEmail", ["draft", email("e5", { subject: "Re: Lunch", sender: A, thread_id: null, in_reply_to: "e1" }), []]);
	await same("unknown folder", A, "createEmail", ["nowhere", email("bad"), []], (r) => (r?.error ? "error" : r));
	assert.equal(await same("inbound Message-ID", A, "hasInboundMessageId", ["e1@example.net"]), true);
	assert.equal(await same("sent Message-ID", A, "hasInboundMessageId", ["e2@example.net"]), false);
	assert.equal(await same("another mailbox Message-ID", A, "hasInboundMessageId", ["e4@example.net"]), false);
	assert.equal(await same("unknown Message-ID", A, "hasInboundMessageId", ["unknown@example.net"]), false);

	await same("getEmail", A, "getEmail", ["e1"]);
	await same("getEmail other address", A, "getEmail", ["e4"]);
	await same("getEmails inbox", A, "getEmails", [{ folder: "inbox" }], dropSnippet);
	await same("getEmails by name", A, "getEmails", [{ folder: "Inbox", sortColumn: "subject", sortDirection: "ASC" }], dropSnippet);
	await same("getThreadEmails", A, "getThreadEmails", ["e1"]);
	await same("getAttachment", A, "getAttachment", ["att1"]);
	await same("getAttachment wrong address", B, "getAttachment", ["att1"]);
});

test("flags, moves and deletes", async () => {
	await same("markThreadRead", A, "markThreadRead", ["e1"]);
	await same("updateEmail star", A, "updateEmail", ["e3", { starred: true }]);
	await same("moveEmail archive", A, "moveEmail", ["e3", "archive"]);
	await same("moveEmail unknown folder", A, "moveEmail", ["e3", "nowhere"]);
	await same("delete outside trash refused", A, "deleteEmail", ["e3"], (r) => (r?.error ? "error" : r));
	await same("trashOrDelete moves to trash", A, "trashOrDelete", ["e3"]);
	await same("trashOrDelete in trash deletes", A, "trashOrDelete", ["e3"]);
	await same("trashOrDelete missing", A, "trashOrDelete", ["e3"]);
	await same("after delete", A, "getEmail", ["e3"]);
});

test("search, threading and send limits", async () => {
	await same("findThreadBySubject", A, "findThreadBySubject", ["RE: invoice october", "ann@example.net"]);
	await same("findThreadBySubject other sender", A, "findThreadBySubject", ["Invoice October", "zed@example.net"]);
	await same("findThreadBySubject outsider", A, "findThreadBySubject", ["Re: Invoice October", "zed@example.net"]);
	await same("findThreadByMessageIds", A, "findThreadByMessageIds", [["unknown@example.net", "e2@example.net"]]);
	await same("findThreadByMessageIds miss", A, "findThreadByMessageIds", [["unknown@example.net"]]);
	await same("checkSendRateLimit", A, "checkSendRateLimit");
	await same("claim new", A, "claimSendKey", ["k1"]);
	await same("claim pending", A, "claimSendKey", ["k1"]);
	await same("finish", A, "finishSendKey", ["k1", "e2"]);
	await same("claim sent", A, "claimSendKey", ["k1"]);
	await same("release sent is a no-op", A, "releaseSendKey", ["k1"]);
	await same("claim still sent", A, "claimSendKey", ["k1"]);
	await same("keys are per address", B, "claimSendKey", ["k1"]);
});

test("scheduled send", async () => {
	const sendAt = new Date(Date.now() + 3_600_000).toISOString();
	const shape = (r) => (r?.id ? { sendAt: r.sendAt, id: "id" } : r);
	await same("schedule", A, "scheduleSend", [{ sendAt, mode: "new", email: { to: "bob@example.org", from: A, subject: "Later", html: "<p>Later</p>" } }], shape);
	await same("schedule reply to a missing original", A, "scheduleSend", [{ sendAt, mode: "reply", originalId: "missing", email: { to: "bob@example.org", from: A, subject: "Re", html: "x" } }]);
	const listed = await same("list", A, "listScheduled", [], (rows) => rows.map((r) => ({ ...r, emailId: "id" })));
	assert.equal(listed.length, 1);
	const [doRows, d1Rows] = await both(A, "listScheduled");
	const [doCancel, d1Cancel] = [await raw("do", A, "cancelScheduled", doRows[0].emailId), await raw("d1", A, "cancelScheduled", d1Rows[0].emailId)];
	assert.deepEqual(d1Cancel, doCancel);
	await same("list after cancel", A, "listScheduled");
	await same("draft stays", A, "getEmails", [{ folder: "draft" }], (rows) => rows.map((r) => r.subject).sort());
});

test("the combined list, facets, labels, bulk and undo", async () => {
	await same("inbox", "all", "queryMail", [{ view: "inbox", address: [], from: [], label: [], is: [], has: [], subject: [], q: "", sort: "date", dir: "desc", tzOffset: 0 }], pageKeys);
	const all = { view: "all", address: [], from: [], label: [], is: [], has: [], subject: [], q: "", sort: "date", dir: "desc", tzOffset: 0 };
	await same("all", "all", "queryMail", [all], pageKeys);
	// Newest first: D1 ranks searches by relevance and the Durable Objects do not.
	await same("search", "all", "queryMail", [{ ...all, q: "invoice sort:date" }], pageKeys);
	await same("facets", "all", "queryFacets", [all]);
	await same("folderViews", "all", "folderViews");
	await same("trashCount", "all", "trashCount");

	await same("createLabel", "all", "createLabel", [{ name: "Money", color: "green" }]);
	await same("createLabel duplicate", "all", "createLabel", [{ name: "money" }]);
	await same("updateLabel", "all", "updateLabel", ["money", { color: "blue" }]);
	await same("markLabelsAuto", "all", "markLabelsAuto", [["money", "missing"]]);
	const key = await same("threadKeyOf", "all", "threadKeyOf", [A, "e1"]);
	await same("threadKeysMatching", "all", "threadKeysMatching", [{ ...all, address: [A] }, 10], (keys) => keys.map(uuid));

	const label = await same("bulk label", "all", "bulk", [{ threadKeys: [key], view: "all" }, { type: "label_add", labelId: "money" }], noUndoId);
	assert.equal(label.affected, 3, "the message, its sent reply and the reply draft all get the label");
	await same("labels listed", "all", "listLabels");
	await same("labeled list", "all", "queryMail", [{ ...all, label: ["money"] }], pageKeys);

	const [doArchive, d1Archive] = await both("all", "bulk", { threadKeys: [key], view: "inbox" }, { type: "archive" });
	assert.deepEqual(noUndoId(d1Archive), noUndoId(doArchive));
	await same("after archive", "all", "queryMail", [{ ...all, view: "archive" }], pageKeys);
	const [doUndo, d1Undo] = [await raw("do", "all", "undo", doArchive.undoId), await raw("d1", "all", "undo", d1Archive.undoId)];
	assert.deepEqual(d1Undo, doUndo);
	await same("after undo", "all", "queryMail", [{ ...all, view: "inbox" }], pageKeys);
	await same("undo twice", "all", "undo", ["gone"]);

	await same("bulk by filter conflict", "all", "bulk", [{ filter: all, asOf: new Date().toISOString(), expectedCount: 99 }, { type: "read" }]);
	await same("bulk read by filter", "all", "bulk", [{ filter: { ...all, address: [B] }, asOf: new Date().toISOString(), expectedCount: 1 }, { type: "read" }], noUndoId);

	await same("deleteLabel", "all", "deleteLabel", ["money"]);
	await same("deleteLabel missing", "all", "deleteLabel", ["money"]);
	await same("labels after delete", "all", "listLabels");

	await same("trash one", B, "trashOrDelete", ["e4"]);
	await same("trashCount", "all", "trashCount");
	await same("emptyTrash conflict", "all", "emptyTrash", [5]);
	await same("emptyTrash", "all", "emptyTrash", [1]);
	await same("trash empty", "all", "trashCount");
});

test("folder import turns a custom folder into a label", async () => {
	// Custom folders predate labels; neither store creates them through the contract.
	await raw("do", A, "createFolder", "receipts", "Receipts");
	await raw("d1", "-", "_sql", `INSERT INTO folders (mailbox_id, id, name) VALUES ('${A}', 'receipts', 'Receipts')`);
	await same("store in folder", A, "createEmail", ["receipts", email("r1", { subject: "Receipt 1" }), []]);
	await same("store in folder 2", A, "createEmail", ["receipts", email("r2", { subject: "Receipt 2" }), []]);
	await same("counts", A, "folderImportCounts");
	await same("ids", A, "folderEmailIds", ["receipts"]);
	await same("label for it", "all", "createLabel", [{ name: "Receipts", id: "receipts" }]);
	await same("import", A, "importFolder", ["receipts", "receipts"]);
	await same("import again is a no-op", A, "importFolder", ["receipts", "receipts"]);
	await same("system folders are refused", A, "importFolder", ["inbox", "receipts"], (r) => (r?.error ? "error" : r));
	await same("mark imported", A, "markFoldersImported");
	await same("moves into custom folders stop", A, "moveEmail", ["r1", "receipts"]);
	await same("counts after", A, "folderImportCounts");
});

test("a body over 512 KB lives in R2 on D1 and reads back the same", async () => {
	const big = `<p>${"x".repeat(600 * 1024)}</p>`;
	await same("store big", A, "createEmail", ["trash", email("big1", { body: big }), []]);
	const [doEmail, d1Email] = await both(A, "getEmail", "big1");
	assert.equal(d1Email.body, big);
	assert.deepEqual(d1Email, doEmail);
	const bucket = await mf.getR2Bucket("BUCKET");
	assert.ok(await bucket.head("bodies/big1.html"), "D1 keeps the body in R2");
	await same("delete big", A, "deleteEmail", ["big1"]);
	assert.equal(await bucket.head("bodies/big1.html"), null, "deleting the message deletes its body");
});
