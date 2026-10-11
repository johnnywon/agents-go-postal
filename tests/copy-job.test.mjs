import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { statements } from "./helpers/schema.mjs";
import { D1_SCHEMA } from "./helpers/d1-schema.mjs";

// The copy from the Durable Objects to D1 (workers/store/copy-job.ts): mail
// stored on the old store reads back the same from D1, including what
// changed while the copy ran.

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
	for (const s of statements(SCHEMA)) await call("d1", "-", "_sql", s);
	const bucket = await mf.getR2Bucket("BUCKET");
	await bucket.put(`mailboxes/${A}.json`, JSON.stringify({ displayName: "Ann" }));
	await bucket.put(`mailboxes/${B}.json`, "{}");
	for (const m of [A, B]) await call("do", m, "_teach");
});

after(async () => {
	await mf?.dispose();
});

async function raw(store, target, op, ...args) {
	const response = await mf.dispatchFetch("http://test/", { method: "POST", body: JSON.stringify({ store, target, op, args }) });
	return response.json();
}

async function call(store, target, op, ...args) {
	const r = await raw(store, target, op, ...args);
	if (r.error !== undefined) throw new Error(`${store} ${op}: ${r.error}`);
	return r.ok;
}

/** The same call on both stores must return the same thing. */
async function same(label, target, op, args = [], normalize = (x) => x) {
	const a = await call("do", target, op, ...args);
	const b = await call("d1", target, op, ...args);
	assert.deepEqual(normalize(b), normalize(a), `${label}: D1 differs from the Durable Object store`);
	return a;
}

const hoursAgo = (h) => new Date(Date.now() - h * 3_600_000).toISOString();
const email = (id, fields = {}) => ({
	id, subject: "Hello", sender: "ann@example.net", recipient: A, cc: null, bcc: null, date: hoursAgo(1),
	body: "<p>Hello there</p>", thread_id: id, message_id: `${id}@example.net`, raw_headers: JSON.stringify([{ key: "from", value: "Ann <ann@example.net>" }]),
	...fields,
});
const all = { view: "all", address: [], from: [], label: [], is: [], has: [], subject: [], q: "", sort: "date", dir: "desc", tzOffset: 0 };
const dropSnippet = (rows) => (Array.isArray(rows) ? rows.map(({ snippet, ...rest }) => rest) : rows);
const BIG = `<p>${"long ".repeat(130_000)}</p>`; // over 512 KB, so D1 keeps it in R2
let scheduled = [];

async function advanceUntil(store, want, options = {}) {
	for (let i = 0; i < 20; i++) {
		const state = await call(store, "-", "_advance", options);
		if (state === want) return state;
	}
	throw new Error(`the copy never reached ${want}`);
}

test("mail on the Durable Objects", async () => {
	const doStore = (target, op, ...args) => call("do", target, op, ...args);
	await doStore(A, "createEmail", "inbox", email("e1", { subject: "Invoice October", body: "<p>Your invoice is attached</p>" }), [
		{ id: "att1", email_id: "e1", filename: "invoice.pdf", mimetype: "application/pdf", size: 1200, content_id: null, disposition: "attachment" },
	]);
	await doStore(A, "createEmail", "sent", email("e2", { subject: "Re: Invoice October", sender: A, recipient: "ann@example.net", thread_id: "e1", in_reply_to: "e1@example.net", date: hoursAgo(0.5) }), []);
	await doStore(A, "createEmail", "inbox", email("e3", { subject: "Weekly digest", sender: "news@example.net", date: hoursAgo(30), raw_headers: JSON.stringify([{ key: "list-id", value: "<news.example.net>" }]) }), []);
	await doStore(A, "createEmail", "inbox", email("e4", { subject: "Long report", body: BIG, date: hoursAgo(3) }), []);
	await call("do", A, "_internal", "createFolder", "receipts", "Receipts");
	await doStore(A, "createEmail", "receipts", email("r1", { subject: "Receipt 1", date: hoursAgo(5) }), []);
	await doStore(B, "createEmail", "inbox", email("b1", { subject: "Lunch", recipient: B, date: hoursAgo(2) }), []);
	await doStore(B, "createEmail", "inbox", email("b2", { subject: "Dinner", recipient: B, date: hoursAgo(4) }), []);
	await doStore(A, "updateEmail", "e3", { starred: true });
	assert.ok((await doStore("all", "createLabel", { name: "Money" })).label);
	const key = await doStore("all", "threadKeyOf", A, "e1");
	await doStore("all", "bulk", { threadKeys: [key], view: "all" }, { type: "label_add", labelId: "money" });
	await doStore(A, "claimSendKey", "k1");
	await doStore(A, "finishSendKey", "k1", "e2");
	const sendAt = new Date(Date.now() + 3_600_000).toISOString();
	for (const subject of ["Later", "Cancel me"]) {
		const r = await doStore(A, "scheduleSend", { sendAt, mode: "new", email: { to: "bob@example.org", from: A, subject, html: `<p>${subject}</p>` } });
		scheduled.push(r.id);
	}
});

test("a copy starts only from the Durable Objects into an empty database", async () => {
	assert.equal(await call("do", "-", "_copyStartError"), null);
	assert.match(await call("d1", "-", "_copyStartError"), /already runs on D1/);
	assert.deepEqual((await call("do", "-", "_copyStatus")).state, "none");
	await call("do", "-", "_copyStart");
	assert.match(await call("do", "-", "_copyStartError"), /already started/);
});

test("the copy runs in slices and picks up changes made during it", async () => {
	// A clock that moves a second per reading: the slice stops after a few small pages.
	assert.equal(await call("do", "-", "_advance", { tick: 1000, runMs: 2500, pageSize: 2 }), "copying");
	const partial = await call("do", "-", "_copyStatus");
	assert.equal(partial.state, "copying");
	assert.ok(partial.mailboxes.length >= 1 && !partial.mailboxes.every((m) => m.pagesDone), JSON.stringify(partial.mailboxes));

	// Changes while the copy runs.
	await call("do", A, "markThreadRead", "e1");
	await call("do", A, "trashOrDelete", "e3");
	await call("do", A, "trashOrDelete", "e3");
	await call("do", A, "createEmail", "inbox", email("e6", { subject: "Arrived mid-copy", date: hoursAgo(0.1) }), []);
	await call("do", A, "cancelScheduled", scheduled[1]);
	assert.ok((await call("do", "all", "createLabel", { name: "Later" })).label);
	await call("do", "all", "bulk", { threadKeys: [await call("do", "all", "threadKeyOf", B, "b1")], view: "all" }, { type: "label_add", labelId: "later" });

	assert.equal(await advanceUntil("do", "ready", { pageSize: 2 }), "ready");
	const status = await call("do", "-", "_copyStatus");
	assert.equal(status.error, null);
	assert.ok(status.parity.ok, JSON.stringify(status.parity, null, 1));
	assert.deepEqual(status.parity.labels.d1, ["later", "money"]);
	assert.deepEqual(status.mailboxes.map((m) => [m.mailboxId, m.pagesDone]), [[A, true], [B, true]]);
});

test("D1 reads back what the Durable Objects hold", async () => {
	for (const id of ["e1", "e2", "e3", "e4", "e6", "r1", ...scheduled]) await same(`getEmail ${id}`, A, "getEmail", [id]);
	for (const id of ["b1", "b2"]) await same(`getEmail ${id}`, B, "getEmail", [id]);
	assert.equal((await call("d1", A, "getEmail", "e4")).body, BIG, "the large body comes back from R2");
	await same("inbox", A, "getEmails", [{ folder: "inbox" }], dropSnippet);
	await same("receipts", A, "getEmails", [{ folder: "receipts" }], dropSnippet);
	await same("thread", A, "getThreadEmails", ["e1"]);
	await same("attachment", A, "getAttachment", ["att1"]);
	await same("scheduled", A, "listScheduled");
	await same("send key", A, "claimSendKey", ["k1"]);
	const pageKeys = (page) => page.conversations.map((c) => ({ key: c.thread_key, email: c.email_id, count: c.thread_count, unread: c.thread_unread_count, labels: c.labels, state: c.state, starred: c.starred }));
	for (const view of ["inbox", "all", "sent", "drafts", "starred", "trash", "folder:receipts"]) await same(`list ${view}`, "all", "queryMail", [{ ...all, view }], pageKeys);
	await same("list by label", "all", "queryMail", [{ ...all, label: ["later"] }], pageKeys);
	// Newest first: D1 ranks searches by relevance and the Durable Objects do not.
	await same("list search", "all", "queryMail", [{ ...all, q: "invoice sort:date" }], pageKeys);
	await same("facets", "all", "queryFacets", [all]);
	await same("folders", "all", "folderViews");
	await same("labels", "all", "listLabels");
	await same("trash", "all", "trashCount");
	assert.deepEqual(await call("d1", "-", "_rows", `SELECT settings FROM mailboxes WHERE id = '${A}'`), [{ settings: JSON.stringify({ displayName: "Ann" }) }]);
});

test("while ready, each run keeps D1 current", async () => {
	await call("do", B, "updateEmail", "b2", { read: true });
	assert.equal(await call("do", "-", "_advance"), "ready");
	await same("after a later change", B, "getEmail", ["b2"]);
	assert.ok((await call("do", "-", "_copyStatus")).parity.ok);
});

test("the first run on D1 makes the last pass and stops tracking", async () => {
	await call("do", A, "updateEmail", "e6", { starred: true });
	// Scheduled on D1 between the deploy and the last pass: the pass must keep it.
	const onD1 = await call("d1", A, "scheduleSend", { sendAt: new Date(Date.now() + 7_200_000).toISOString(), mode: "new", email: { to: "bob@example.org", from: A, subject: "On D1", html: "<p>x</p>" } });
	assert.equal(await call("d1", "-", "_advance"), "done");
	assert.deepEqual((await call("d1", A, "listScheduled")).map((r) => r.emailId).sort(), [scheduled[0], onD1.id].sort());
	const status = await call("d1", "-", "_copyStatus");
	assert.equal(status.state, "done");
	assert.ok(status.finishedAt);
	assert.equal((await call("d1", A, "getEmail", "e6")).starred, true, "the change just before cutover arrived");
	for (const m of [A, B]) assert.equal((await call("do", m, "_internal", "copyStatus")).tracking, false);
	assert.deepEqual(await call("do", A, "listScheduled"), [], "the old store no longer holds schedules that D1 sends");
	assert.ok(await call("do", A, "getEmail", scheduled[0]), "its draft stays");
	assert.equal(await call("d1", "-", "_advance"), "done", "later runs do nothing");
});

test("after cutover, inbound mail is also written to the old mailbox", async () => {
	await call("d1", A, "createEmail", "inbox", email("m1", { subject: "After cutover" }), []);
	await call("d1", A, "_mirror", "inbox", email("m1", { subject: "After cutover" }), []);
	assert.equal((await call("do", A, "getEmail", "m1")).subject, "After cutover");
	await call("do", A, "_mirror", "inbox", email("m2"), []);
	assert.equal(await call("do", A, "getEmail", "m2"), null, "no mirror while the Durable Objects are the store");
});
