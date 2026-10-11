import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTs, openDb } from "./helpers/sqlite.mjs";

const idx = await loadTs("workers/lib/mail-index-sql.ts");
const bulk = await loadTs("workers/lib/mail-bulk-sql.ts");
const tools = await loadTs("workers/lib/tools.ts");

const labels = [{ id: "receipts", name: "Receipts", color: "#000", count: 0, auto: false }];

function row(email_id, fields = {}) {
	return {
		email_id, seq: 1, deleted: false, conversation_id: email_id, message_id: `${email_id}@mail`, state: "inbox",
		date: "2026-10-09T10:00:00.000Z", sender_addr: "billing@example.org", sender_name: "Billing", sender_domain: "example.org",
		recipients: "a@example.com", subject: "Your receipt", subject_norm: "your receipt", snippet: "", unread: true, starred: false,
		has_attachment: false, list_id: null, unsubscribe: null, body_text: "", labels: [], ...fields,
	};
}

test("a search spans every address unless it names one", () => {
	const handle = openDb();
	idx.createIndexSchema(handle.exec);
	idx.applyRows(handle.exec, "a@example.com", [row("e1"), row("e2", { sender_addr: "ann@example.net", sender_domain: "example.net", date: "2026-10-08T10:00:00.000Z" })]);
	idx.applyRows(handle.exec, "b@example.net", [row("e3", { state: "archive", date: "2026-10-10T10:00:00.000Z" })]);

	const all = tools.mailSearchFilter({ from: ["example.org"] }, labels);
	assert.deepEqual(bulk.matchingThreadKeys(handle.exec, all.filter, 10).length, 2, "both addresses, inbox and archive");
	const one = tools.mailSearchFilter({ from: ["example.org"], to: ["b@example.net"] }, labels);
	assert.equal(bulk.matchingThreadKeys(handle.exec, one.filter, 10).length, 1);
	assert.equal(bulk.matchingThreadKeys(handle.exec, all.filter, 1).length, 1, "limit holds");
});

test("the search filter refuses unknown labels, folders and an empty search", () => {
	assert.match(tools.mailSearchFilter({ label: ["Nope"] }, labels).error, /Unknown label/);
	assert.match(tools.mailSearchFilter({ folder: "elsewhere", query: "x" }, labels).error, /Unknown folder/);
	assert.match(tools.mailSearchFilter({}, labels).error, /at least one/);
	assert.deepEqual(tools.mailSearchFilter({ label: ["receipts"], unread: false }, labels).filter.label, ["receipts"]);
	assert.deepEqual(tools.mailSearchFilter({ unread: false, query: "x" }, labels).filter.is, ["read"]);
});

test("label_matching labels every match in one bulk call per label", async () => {
	const calls = [];
	let matches = ["t1", "t2", "t3"];
	const indexStub = {
		listLabels: async () => labels,
		threadKeysMatching: async () => matches,
		bulk: async (target, action) => (calls.push({ n: target.threadKeys.length, action }), { affected: 3, undoId: "u", failed: [] }),
		markLabelsAuto: async () => ({}),
	};
	const env = { MAIL_INDEX: { idFromName: () => "global", get: () => indexStub } };

	const done = await tools.toolLabelMatching(env, { from: ["example.org"] }, { add: ["Receipts"] });
	assert.deepEqual(done, { status: "updated", conversations: 3, changes: ["added Receipts"] });
	assert.deepEqual(calls, [{ n: 3, action: { type: "label_add", labelId: "receipts" } }]);

	matches = Array.from({ length: tools.LABEL_MATCHING_MAX + 1 }, (_, i) => `t${i}`);
	assert.match((await tools.toolLabelMatching(env, { from: ["example.org"] }, { add: ["Receipts"] })).error, /More than/);
	assert.equal(calls.length, 1, "nothing applied when there are too many");
	assert.match((await tools.toolLabelMatching(env, { from: ["example.org"] }, {})).error, /which labels/);
});
