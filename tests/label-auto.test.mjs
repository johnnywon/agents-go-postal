import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTs, openDb } from "./helpers/sqlite.mjs";

const idx = await loadTs("workers/lib/mail-index-sql.ts");
const bulk = await loadTs("workers/lib/mail-bulk-sql.ts");
const tools = await loadTs("workers/lib/tools.ts");

function index() {
	const handle = openDb();
	idx.createIndexSchema(handle.exec);
	return handle;
}

test("listLabels reports auto once an agent has applied a label", () => {
	const { exec } = index();
	bulk.createLabel(exec, { name: "Receipts" });
	bulk.createLabel(exec, { name: "Travel" });
	assert.deepEqual(bulk.listLabels(exec).map((l) => [l.id, l.auto]), [["receipts", false], ["travel", false]]);

	assert.deepEqual(bulk.markLabelsAuto(exec, ["travel", "travel", "missing"], "2026-10-11T12:00:00.000Z"), ["travel"]);
	assert.deepEqual(bulk.markLabelsAuto(exec, ["travel"], "2026-10-11T13:00:00.000Z"), [], "already flagged");
	assert.equal(exec(`SELECT applied_at FROM label_auto WHERE label_id = 'travel'`)[0].applied_at, "2026-10-11T13:00:00.000Z");
	assert.deepEqual(bulk.listLabels(exec).map((l) => [l.id, l.auto]), [["receipts", false], ["travel", true]]);
});

test("the auto flag survives backup and restore, and goes with the label", () => {
	const { exec } = index();
	bulk.createLabel(exec, { name: "Travel" });
	bulk.markLabelsAuto(exec, ["travel"]);
	const backup = bulk.labelBackup(exec);
	assert.equal(backup[0].auto, true);

	assert.equal(bulk.deleteLabelRows(exec, "travel"), true);
	assert.equal(exec(`SELECT COUNT(*) AS n FROM label_auto`)[0].n, 0);

	assert.equal(bulk.restoreLabels(exec, backup), 1);
	assert.equal(bulk.listLabels(exec)[0].auto, true);
});

test("toolLabelConversation flags every label it adds, not the ones it removes", async () => {
	const labels = [
		{ id: "travel", name: "Travel", color: "#000", count: 0, auto: false },
		{ id: "receipts", name: "Receipts", color: "#000", count: 0, auto: false },
	];
	const calls = { bulk: [], auto: [] };
	const indexStub = {
		listLabels: async () => labels,
		threadKeyOf: async () => "a@example.com\u0000t1",
		bulk: async (target, action) => (calls.bulk.push(action), { affected: 1, undoId: "u", failed: [] }),
		markLabelsAuto: async (ids) => (calls.auto.push(ids), { flagged: ids }),
	};
	const env = { MAIL_INDEX: { idFromName: () => "global", get: () => indexStub } };

	const result = await tools.toolLabelConversation(env, "a@example.com", "e1", { add: ["Travel"], remove: ["receipts"] });
	assert.equal(result.status, "updated");
	assert.deepEqual(calls.auto, [["travel"]]);
	assert.deepEqual(calls.bulk.map((a) => `${a.type}:${a.labelId}`), ["label_add:travel", "label_remove:receipts"]);

	calls.auto.length = 0;
	await tools.toolLabelConversation(env, "a@example.com", "e1", { remove: ["travel"] });
	assert.deepEqual(calls.auto, []);

	const unknown = await tools.toolLabelConversation(env, "a@example.com", "e1", { add: ["Nope"] });
	assert.match(unknown.error, /Unknown label/);
	assert.deepEqual(calls.auto, []);
});

test("toolCreateLabel creates a label once and returns the existing one after", async () => {
	const labels = [{ id: "travel", name: "Travel", color: "#000", count: 0, auto: false }];
	const created = [];
	const indexStub = {
		listLabels: async () => labels,
		createLabel: async (input) => {
			created.push(input);
			const label = { id: input.name.toLowerCase(), name: input.name, color: input.color };
			labels.push({ ...label, count: 0, auto: false });
			return { label };
		},
	};
	const env = { MAIL_INDEX: { idFromName: () => "global", get: () => indexStub } };

	const first = await tools.toolCreateLabel(env, { name: " Receipts " });
	assert.equal(first.status, "created");
	assert.equal(first.label.name, "Receipts");
	assert.equal(created.length, 1);
	assert.match(created[0].color, /^#/, "a palette colour is picked");

	const again = await tools.toolCreateLabel(env, { name: "receipts" });
	assert.equal(again.status, "exists");
	assert.equal(again.label.id, "receipts");
	assert.equal(created.length, 1, "no duplicate");
});

test("toolCreateLabel passes on the index's refusal", async () => {
	const indexStub = { listLabels: async () => [], createLabel: async () => ({ error: "Label name is required" }) };
	const env = { MAIL_INDEX: { idFromName: () => "global", get: () => indexStub } };
	assert.deepEqual(await tools.toolCreateLabel(env, { name: "x" }), { error: "Label name is required" });
});
