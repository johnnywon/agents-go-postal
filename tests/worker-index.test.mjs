import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

// End to end in local workerd: MailboxDO outbox -> MailIndexDO, delete safety, rebuild.

let mf;

before(async () => {
	const bundle = await build({
		entryPoints: ["tests/fixtures/index-worker.ts"],
		bundle: true,
		format: "esm",
		platform: "neutral",
		conditions: ["workerd", "worker", "browser"],
		mainFields: ["module", "main"],
		external: ["cloudflare:workers"],
		write: false,
		logLevel: "silent",
	});
	mf = new Miniflare({
		modules: true,
		script: bundle.outputFiles[0].text,
		compatibilityDate: "2025-11-28",
		compatibilityFlags: ["nodejs_compat"],
		bindings: { EMAIL_ADDRESSES: ["a@example.com", "b@example.org"], INDEX_SYNC_ENABLED: "true" },
		r2Buckets: ["BUCKET"],
		durableObjects: {
			MAILBOX: { className: "MailboxDO", useSQLite: true },
			MAIL_INDEX: { className: "MailIndexDO", useSQLite: true },
		},
	});
});

after(async () => {
	await mf?.dispose();
});

async function call(target, op, ...args) {
	const response = await mf.dispatchFetch("http://test/", { method: "POST", body: JSON.stringify({ target, op, args }) });
	return response.json();
}

async function ok(target, op, ...args) {
	const result = await call(target, op, ...args);
	assert.equal(result.error, undefined, `${target}.${op}: ${result.error}`);
	return result.ok;
}

const filter = (overrides = {}) => ({
	view: "inbox", address: [], from: [], label: [], is: [], has: [], subject: [], q: "", sort: "date", dir: "desc", tzOffset: 0, ...overrides,
});

let n = 0;
function email(fields = {}) {
	const id = `m${++n}`;
	return {
		id, subject: `Subject ${id}`, sender: "ann@example.net", recipient: "a@example.com", date: new Date(Date.UTC(2026, 9, 1, n)).toISOString(),
		body: `<p>body ${id}</p>`, thread_id: id, message_id: `${id}@mail`, ...fields,
	};
}

async function waitFor(check, label) {
	for (let i = 0; i < 100; i++) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	assert.fail(`timed out waiting for ${label}`);
}

test("rebuild indexes existing mail and teaches each mailbox its address", async () => {
	await ok("bucket", "put", "a@example.com");
	await ok("bucket", "put", "b@example.org");
	// Mail created before the mailbox knows its address stays in the outbox.
	await ok("a@example.com", "createEmail", "inbox", email({ body: "<p>quarterly invoice</p>" }), []);
	await ok("b@example.org", "createEmail", "inbox", email(), []);
	assert.equal((await ok("a@example.com", "indexStatus")).pending, 1);

	await ok("index", "status"); // empty index starts a rebuild
	await waitFor(async () => (await ok("index", "status")).job?.finishedAt, "rebuild");
	const status = await ok("index", "status");
	assert.equal(status.messages, 2);
	assert.equal(status.probe, "ok");
	assert.equal((await ok("a@example.com", "indexStatus")).pending, 0);
	assert.equal((await ok("a@example.com", "indexStatus")).mailboxId, "a@example.com");

	const page = await ok("index", "queryMail", filter({ q: "invoice" }));
	assert.deepEqual(page.conversations.map((c) => c.mailbox_id), ["a@example.com"]);
});

test("live changes reach the index before the call returns", async () => {
	const e = email({ subject: "Live one" });
	await ok("a@example.com", "createEmail", "inbox", e, []);
	let page = await ok("index", "queryMail", filter({ address: ["a@example.com"] }));
	assert.equal(page.conversations[0].email_id, e.id);
	assert.equal(page.conversations[0].unread, true);

	await ok("a@example.com", "updateEmail", e.id, { starred: true });
	await ok("a@example.com", "markThreadRead", e.id);
	page = await ok("index", "queryMail", filter({ view: "starred" }));
	assert.equal(page.conversations[0].email_id, e.id);
	assert.equal(page.conversations[0].unread, false);

	await ok("a@example.com", "moveEmail", e.id, "archive");
	page = await ok("index", "queryMail", filter({ view: "archive" }));
	assert.deepEqual(page.conversations.map((c) => c.email_id), [e.id]);
});

test("delete moves mail to Trash, and only Trash and Drafts delete permanently", async () => {
	const e = email();
	await ok("a@example.com", "createEmail", "inbox", e, []);
	assert.match((await call("a@example.com", "deleteEmail", e.id)).error, /Trash or Drafts/);

	assert.equal((await ok("a@example.com", "trashOrDelete", e.id)).action, "trashed");
	assert.equal((await ok("a@example.com", "getEmail", e.id)).folder_id, "trash");
	let trash = await ok("index", "queryMail", filter({ view: "trash" }));
	assert.ok(trash.conversations.some((c) => c.email_id === e.id));

	assert.equal((await ok("a@example.com", "trashOrDelete", e.id)).action, "deleted");
	assert.equal(await ok("a@example.com", "getEmail", e.id), null);
	trash = await ok("index", "queryMail", filter({ view: "trash" }));
	assert.ok(!trash.conversations.some((c) => c.email_id === e.id));

	const draft = email();
	await ok("a@example.com", "createEmail", "draft", draft, []);
	assert.equal((await ok("a@example.com", "trashOrDelete", draft.id)).action, "deleted");
	assert.equal(await ok("a@example.com", "trashOrDelete", "missing"), null);
});

test("a folder that holds mail cannot be deleted", async () => {
	await ok("a@example.com", "createFolder", "receipts", "Receipts");
	const e = email();
	await ok("a@example.com", "createEmail", "receipts", e, []);
	assert.equal(await ok("a@example.com", "deleteFolder", "receipts"), "not_empty");
	assert.equal((await ok("a@example.com", "getEmail", e.id)).folder_id, "receipts");
	await ok("a@example.com", "moveEmail", e.id, "archive");
	assert.equal(await ok("a@example.com", "deleteFolder", "receipts"), "deleted");
	assert.equal(await ok("a@example.com", "deleteFolder", "inbox"), "not_found");
});

test("index counts match the mailbox's own counts", async () => {
	const [source, index] = await Promise.all([ok("a@example.com", "indexStatus"), ok("index", "status")]);
	assert.deepEqual(index.counts["a@example.com"].states, source.counts.states);
	assert.equal(index.counts["a@example.com"].unread, source.counts.unread);
	assert.equal(index.counts["a@example.com"].starred, source.counts.starred);
	assert.equal(index.counts["a@example.com"].inboxConversations, source.inboxConversations);
	assert.equal(index.counts["a@example.com"].appliedSeq, source.seq);
});

test("a second rebuild keeps the same rows and drops purged ones", async () => {
	const before = (await ok("index", "status")).messages;
	await ok("index", "startRebuild");
	await waitFor(async () => (await ok("index", "status")).job?.finishedAt, "second rebuild");
	assert.equal((await ok("index", "status")).messages, before);
	await ok("index", "purgeMailbox", "b@example.org");
	assert.equal((await ok("index", "status")).counts["b@example.org"], undefined);
});

test("bulk archive goes through each mailbox, and undo restores it", async () => {
	const x = email({ subject: "Bulk one" });
	const y = email({ subject: "Bulk two" });
	await ok("a@example.com", "createEmail", "inbox", x, []);
	await ok("b@example.org", "setMailboxId", "b@example.org");
	await ok("b@example.org", "createEmail", "inbox", y, []);
	const inbox = await ok("index", "queryMail", filter());
	const keys = inbox.conversations.filter((c) => [x.id, y.id].includes(c.email_id)).map((c) => c.thread_key);
	assert.equal(keys.length, 2);

	const result = await ok("index", "bulk", { threadKeys: keys, view: "inbox" }, { type: "archive" });
	assert.equal(result.affected, 2);
	assert.deepEqual(result.failed, []);
	assert.equal((await ok("a@example.com", "getEmail", x.id)).folder_id, "archive");
	const archive = await ok("index", "queryMail", filter({ view: "archive" }));
	assert.ok(archive.conversations.some((c) => c.email_id === y.id));

	assert.equal((await ok("index", "undo", result.undoId)).affected, 2);
	assert.equal((await ok("b@example.org", "getEmail", y.id)).folder_id, "inbox");
	assert.equal(await ok("index", "undo", result.undoId), null);
});

test("a filter target with a stale count is refused", async () => {
	const all = await ok("index", "queryMail", filter());
	const result = await ok("index", "bulk", { filter: filter(), asOf: new Date(Date.now() + 60_000).toISOString(), expectedCount: all.total + 1 }, { type: "read" });
	assert.equal(result.conflict, all.total);
});

test("Empty Trash deletes only Trash mail, its blobs and its index rows", async () => {
	const junk = email({ subject: "old junk" });
	const attachment = { id: "att1", email_id: junk.id, filename: "x.pdf", mimetype: "application/pdf", size: 3, content_id: null, disposition: "attachment" };
	await ok("a@example.com", "createEmail", "trash", junk, [attachment]);
	await ok("bucket-raw", "put", `attachments/${junk.id}/att1/x.pdf`, "pdf");
	const kept = email();
	await ok("a@example.com", "createEmail", "inbox", kept, []);
	const draft = email();
	await ok("a@example.com", "createEmail", "draft", draft, []);

	const before = await ok("index", "trashCount");
	assert.ok(before.messages >= 1);
	assert.deepEqual(await ok("index", "emptyTrash", before.messages + 1), { conflict: before.messages });
	assert.ok(await ok("a@example.com", "getEmail", junk.id), "a refused Empty Trash deletes nothing");

	const result = await ok("index", "emptyTrash", before.messages);
	assert.deepEqual(result, { deleted: before.messages, failed: [] });
	assert.deepEqual(await ok("index", "trashCount"), { messages: 0, conversations: 0 });
	assert.equal(await ok("bucket-head", "head", `attachments/${junk.id}/att1/x.pdf`), false);
	assert.equal(await ok("a@example.com", "getEmail", junk.id), null);
	assert.ok(await ok("a@example.com", "getEmail", kept.id));
	assert.ok(await ok("a@example.com", "getEmail", draft.id));

	// The mailbox re-checks the folder: ids outside Trash are left alone.
	assert.deepEqual(await ok("a@example.com", "purgeTrash", [kept.id, draft.id]), { changed: [], attachments: [] });
	assert.ok(await ok("a@example.com", "getEmail", kept.id));
});

test("labels: create, apply across mailboxes, filter, back up, and delete", async () => {
	const { label } = await ok("index", "createLabel", { name: "Receipts", color: "#c8372d" });
	assert.equal(label.id, "receipts");
	assert.match((await ok("index", "createLabel", { name: "receipts" })).error, /exists/);
	assert.deepEqual((await ok("bucket-get", "get", "backups/labels.json")).map((l) => l.id), ["receipts"]);

	const inbox = await ok("index", "queryMail", filter());
	const keys = inbox.conversations.slice(0, 2).map((c) => c.thread_key);
	const added = await ok("index", "bulk", { threadKeys: keys, view: "inbox" }, { type: "label_add", labelId: "receipts" });
	assert.ok(added.affected >= 2);
	const labeled = await ok("index", "queryMail", filter({ label: ["receipts"] }));
	assert.deepEqual(labeled.conversations.map((c) => c.thread_key).sort(), [...keys].sort());
	assert.equal((await ok("index", "listLabels"))[0].count, 2);

	const deleted = await ok("index", "deleteLabel", "receipts");
	assert.equal(deleted.deleted, true);
	assert.equal((await ok("index", "queryMail", filter({ label: ["receipts"] }))).conversations.length, 0);
	assert.deepEqual(await ok("bucket-get", "get", "backups/labels.json"), []);
});

test("folder import: dry run counts, conversion, rerun, and system-only moves afterwards", async () => {
	await ok("a@example.com", "createFolder", "travel", "Travel");
	const t1 = email();
	const t2 = email();
	await ok("a@example.com", "createEmail", "travel", t1, []);
	await ok("a@example.com", "createEmail", "travel", t2, []);

	const dry = await ok("folders", "dry");
	const travel = dry.mailboxes.find((m) => m.mailboxId === "a@example.com").folders.find((f) => f.folderId === "travel");
	assert.equal(travel.count, 2);
	assert.equal((await ok("a@example.com", "getEmail", t1.id)).folder_id, "travel");

	const run = await ok("folders", "run");
	assert.match(run.backup, /^backups\/folder-import-/);
	assert.ok(await ok("bucket-get", "get", run.backup));
	const row = run.results.find((r) => r.folderId === "travel");
	assert.deepEqual([row.labeled, row.archived], [2, 2]);
	assert.equal((await ok("a@example.com", "getEmail", t1.id)).folder_id, "archive");
	const labeled = await ok("index", "queryMail", filter({ view: "all", label: ["travel"] }));
	assert.equal(labeled.conversations.length, 2);

	const again = await ok("folders", "run");
	assert.deepEqual(again.results.map((r) => r.labeled + r.archived), again.results.map(() => 0));
	assert.equal(await ok("a@example.com", "moveEmail", t1.id, "travel"), false);
	assert.equal(await ok("a@example.com", "moveEmail", t1.id, "inbox"), true);
	const folders = await ok("a@example.com", "getFolders");
	assert.equal(folders.find((f) => f.id === "travel").can_move_to, false);
	assert.equal(folders.find((f) => f.id === "inbox").can_move_to, true);
});

test("search window: suggest and saved searches through the index", async () => {
	const out = await ok("index", "suggest", filter({ view: "anywhere" }), "subject from:an", 15);
	assert.equal(out.completions[0].value, "ann@example.net");
	assert.ok(out.count > 0);
	assert.match((await ok("index", "suggest", filter(), "cc:x", -1)).errors[0], /works once mail is stored in D1/);

	const { saved } = await ok("index", "createSavedSearch", { query: "from:ann" });
	assert.equal(saved.name, "from:ann");
	assert.match((await ok("index", "createSavedSearch", { query: "from:ann" })).error, /already saved/, "an input error crosses RPC as a value");
	const [listed] = await ok("index", "listSavedSearches", { tzOffset: 0 });
	assert.ok(listed.count > 0);
	assert.equal((await ok("index", "updateSavedSearch", saved.id, { name: "Ann" })).saved.name, "Ann");
	assert.equal(await ok("index", "deleteSavedSearch", saved.id), true);
	assert.deepEqual(await ok("index", "listSavedSearches"), []);
});
