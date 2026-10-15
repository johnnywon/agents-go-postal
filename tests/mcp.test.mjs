import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { statements } from "./helpers/schema.mjs";
import { D1_SCHEMA } from "./helpers/d1-schema.mjs";

// End to end in local workerd: an MCP SDK client talks to EmailMCP over Streamable HTTP.

const MAILBOX = "a@example.com";
let mf;
let client;

const seeded = [
	{ id: "e1", subject: "Invoice for October", sender: "billing@example.net", body: "<p>Amount due: 42</p>" },
	{ id: "e2", subject: "Weekly digest", sender: "news@example.org", body: "<p>This week</p>" },
].map((e, i) => ({
	recipient: MAILBOX, date: new Date(Date.UTC(2026, 9, 1, i)).toISOString(), read: false, starred: false,
	thread_id: e.id, message_id: `${e.id}@mail`, raw_headers: "[]", ...e,
}));

before(async () => {
	const bundle = await build({
		entryPoints: ["tests/fixtures/mcp-worker.ts"],
		bundle: true,
		format: "esm",
		platform: "neutral",
		conditions: ["workerd", "worker", "browser"],
		mainFields: ["module", "main"],
		external: ["cloudflare:*", "node:*", "path"],
		write: false,
		logLevel: "silent",
	});
	mf = new Miniflare({
		modules: true,
		script: bundle.outputFiles[0].text,
		compatibilityDate: "2025-11-28",
		compatibilityFlags: ["nodejs_compat"],
		bindings: { EMAIL_ADDRESSES: [MAILBOX] },
		email: { send_email: [{ name: "EMAIL" }] },
		r2Buckets: ["BUCKET"],
		d1Databases: ["DB"],
		durableObjects: {
			EMAIL_MCP: { className: "EmailMCP", useSQLite: true },
		},
	});
	for (const s of statements(D1_SCHEMA)) await mf.dispatchFetch("http://test/_sql", { method: "POST", body: s });
	const seed = await mf.dispatchFetch("http://test/_seed", { method: "POST", body: JSON.stringify({ mailbox: MAILBOX, emails: seeded }) });
	assert.equal(seed.status, 200, await seed.text());

	client = new Client({ name: "mcp-test", version: "1.0.0" });
	await client.connect(new StreamableHTTPClientTransport(new URL("http://test/mcp"), {
		fetch: (url, init) => mf.dispatchFetch(url, init),
	}));
});

after(async () => {
	await client?.close();
	await mf?.dispose();
});

/** Call a tool; returns the parsed JSON (or raw text) and whether the server flagged an error. */
async function call(name, args = {}) {
	const result = await client.callTool({ name, arguments: args });
	const text = result.content[0].text;
	let data;
	try { data = JSON.parse(text); } catch { data = text; }
	return { isError: !!result.isError, data };
}

async function ok(name, args) {
	const { isError, data } = await call(name, args);
	assert.equal(isError, false, `${name}: ${JSON.stringify(data)}`);
	return data;
}

const listOf = (data) => (Array.isArray(data) ? data : data.emails);
const found = (data) => data.conversations.map((c) => c.emailId);

test("the server lists every tool", async () => {
	assert.equal(client.getServerVersion().name, "pluramail");
	const { tools } = await client.listTools();
	assert.deepEqual(tools.map((t) => t.name).sort(), [
		"create_draft", "create_label", "delete_email", "delete_label", "draft_reply", "get_email", "get_thread",
		"label_conversation", "label_matching", "list_emails", "list_labels", "list_mailboxes", "list_shortcuts", "mark_email_read",
		"move_email", "rename_label", "reset_shortcuts", "search_all_mail", "search_emails", "send_draft", "set_shortcut", "update_draft",
	]);
});

test("shortcuts can be listed, rebound and reset", async () => {
	const keysOf = async (id) => (await ok("list_shortcuts")).shortcuts.find((s) => s.id === id).keys;
	assert.deepEqual(await keysOf("archive"), ["e"]);

	const saved = await ok("set_shortcut", { shortcut: "Archive", keys: ["S"] });
	assert.deepEqual(saved.keys, ["s"]);
	assert.deepEqual(saved.takenFrom.map((t) => t.id), ["star"]);
	assert.deepEqual(await keysOf("archive"), ["s"]);
	assert.deepEqual(await keysOf("star"), []);

	const refused = await call("set_shortcut", { shortcut: "help", keys: ["h"] });
	assert.equal(refused.isError, true);

	await ok("reset_shortcuts", {});
	assert.deepEqual(await keysOf("archive"), ["e"]);
	assert.deepEqual(await keysOf("star"), ["s"]);
});

test("read tools return the seeded mail", async () => {
	const boxes = await ok("list_mailboxes");
	assert.ok(JSON.stringify(boxes).includes(MAILBOX));

	const inbox = listOf(await ok("list_emails", { mailboxId: MAILBOX }));
	assert.deepEqual(inbox.map((e) => e.id).sort(), ["e1", "e2"]);

	const email = await ok("get_email", { mailboxId: MAILBOX, emailId: "e1" });
	assert.match(email.body, /Amount due: 42/);

	const thread = await ok("get_thread", { mailboxId: MAILBOX, threadId: "e1" });
	assert.deepEqual(thread.messages.map((e) => e.id), ["e1"]);

	assert.deepEqual(found(await ok("search_all_mail", { query: "invoice" })), ["e1"]);
	assert.deepEqual(found(await ok("search_emails", { mailboxId: MAILBOX, query: "digest" })), ["e2"]);
});

test("read state and folder changes stick", async () => {
	await ok("mark_email_read", { mailboxId: MAILBOX, emailId: "e2", read: true });
	assert.equal(!!(await ok("get_email", { mailboxId: MAILBOX, emailId: "e2" })).read, true);

	await ok("move_email", { mailboxId: MAILBOX, emailId: "e2", folderId: "archive" });
	assert.deepEqual(listOf(await ok("list_emails", { mailboxId: MAILBOX, folder: "archive" })).map((e) => e.id), ["e2"]);
	await ok("move_email", { mailboxId: MAILBOX, emailId: "e2", folderId: "inbox" });
});

test("a label can be created, applied, searched, renamed and deleted", async () => {
	const label = await ok("create_label", { name: "Receipts" });
	assert.ok(label.id ?? label.label?.id);

	await ok("label_conversation", { mailboxId: MAILBOX, emailId: "e1", add: ["Receipts"] });
	assert.deepEqual(found(await ok("search_all_mail", { label: ["Receipts"] })), ["e1"]);

	await ok("rename_label", { label: "Receipts", name: "Bills" });
	assert.ok(JSON.stringify(await ok("list_labels")).includes("Bills"));

	const removed = await ok("label_matching", { label: ["Bills"], remove: ["Bills"] });
	assert.equal(removed.conversations, 1);

	await ok("delete_label", { label: "Bills" });
	assert.ok(!JSON.stringify(await ok("list_labels")).includes("Bills"));
});

test("a draft is created, updated under a new id, and sent", async () => {
	const created = await ok("create_draft", { mailboxId: MAILBOX, to: "bob@example.org", subject: "Hello", bodyHtml: "<p>v1</p>" });

	const updated = await ok("update_draft", { mailboxId: MAILBOX, draftId: created.draftId, bodyHtml: "<p>v2</p>" });
	assert.notEqual(updated.newDraftId, created.draftId, "an update replaces the draft");
	assert.equal((await call("get_email", { mailboxId: MAILBOX, emailId: created.draftId })).isError, true, "the old id is gone");
	assert.match((await ok("get_email", { mailboxId: MAILBOX, emailId: updated.newDraftId })).body, /v2/);

	const sent = await ok("send_draft", { mailboxId: MAILBOX, draftId: updated.newDraftId });
	assert.equal(sent.status, "sent");
	assert.deepEqual(listOf(await ok("list_emails", { mailboxId: MAILBOX, folder: "draft" })), []);
	assert.deepEqual(listOf(await ok("list_emails", { mailboxId: MAILBOX, folder: "sent" })).map((e) => e.subject), ["Hello"]);

	const again = await call("send_draft", { mailboxId: MAILBOX, draftId: updated.newDraftId });
	assert.equal(again.data.error, "Draft not found", "a sent draft is gone, so it can't go out twice");
	assert.equal(listOf(await ok("list_emails", { mailboxId: MAILBOX, folder: "sent" })).length, 1);
});

test("a reply draft can be saved and moved to Trash", async () => {
	const reply = await ok("draft_reply", {
		mailboxId: MAILBOX, originalEmailId: "e1", to: "billing@example.net", subject: "Re: Invoice for October", bodyHtml: "<p>Paid</p>",
	});
	await ok("delete_email", { mailboxId: MAILBOX, emailId: reply.draftId });
	assert.deepEqual(listOf(await ok("list_emails", { mailboxId: MAILBOX, folder: "trash" })).map((e) => e.id), [reply.draftId]);
});

test("bad input comes back as an error", async () => {
	const unknown = await call("list_emails", { mailboxId: "nobody@example.com" });
	assert.equal(unknown.isError, true);
	assert.match(unknown.data.error, /not found/);

	const missing = await call("send_draft", { mailboxId: MAILBOX, draftId: "no-such-draft" });
	assert.equal(missing.isError, true);
	assert.equal(missing.data.error, "Draft not found");

	const invalid = await client.callTool({
		name: "draft_reply", arguments: { mailboxId: MAILBOX, originalEmailId: "e1", to: "not-an-address", subject: "s", bodyHtml: "b" },
	}).catch((e) => ({ isError: true, content: [{ text: e.message }] }));
	assert.equal(invalid.isError, true);
	assert.match(invalid.content[0].text, /to/);
});
