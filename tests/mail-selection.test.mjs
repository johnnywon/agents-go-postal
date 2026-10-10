import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTs } from "./helpers/sqlite.mjs";

const s = await loadTs("app/lib/selection.ts");
const o = await loadTs("app/lib/bulk-optimistic.ts");
const ROWS = ["a", "b", "c", "d", "e"];
const keys = (sel) => [...sel.keys].sort();

test("toggle checks and unchecks and moves the anchor", () => {
	let sel = s.toggle(s.EMPTY_SELECTION, "b");
	assert.deepEqual(keys(sel), ["b"]);
	assert.equal(sel.anchor, "b");
	sel = s.toggle(sel, "b");
	assert.deepEqual(keys(sel), []);
	assert.equal(sel.anchor, "b");
});

test("shift-range checks every row between the anchor and the click, in either direction", () => {
	let sel = s.toggle(s.EMPTY_SELECTION, "b");
	sel = s.range(sel, "d", ROWS);
	assert.deepEqual(keys(sel), ["b", "c", "d"]);
	sel = s.toggle(s.EMPTY_SELECTION, "d");
	sel = s.range(sel, "a", ROWS);
	assert.deepEqual(keys(sel), ["a", "b", "c", "d"]);
	assert.deepEqual(keys(s.range(s.EMPTY_SELECTION, "c", ROWS)), ["c"], "no anchor acts as a toggle");
	sel = s.toggle(s.toggle(s.EMPTY_SELECTION, "a"), "a");
	assert.deepEqual(keys(s.range(sel, "c", ROWS)), ["a", "b", "c"], "the anchor survives a toggle-off");
});

test("select all matching is a mode that any toggle leaves", () => {
	let sel = s.selectAll(s.EMPTY_SELECTION, ROWS);
	assert.equal(s.count(sel, 40), 5);
	sel = s.selectAllMatching(sel);
	assert.equal(sel.allMatching, true);
	assert.equal(s.count(sel, 40), 40);
	sel = s.toggle(sel, "a");
	assert.equal(sel.allMatching, false);
	assert.deepEqual(keys(sel), ["b", "c", "d", "e"]);
	assert.equal(s.count(s.clear(), 40), 0);
});

test("prune drops rows that left the list", () => {
	const sel = s.selectAll(s.EMPTY_SELECTION, ROWS);
	assert.deepEqual(keys(s.prune(sel, ["a", "c"])), ["a", "c"]);
	const same = s.prune(s.toggle(s.EMPTY_SELECTION, "a"), ROWS);
	assert.deepEqual(keys(same), ["a"]);
});

const row = (fields = {}) => ({
	thread_key: "k", mailbox_id: "a@wayne.org", state: "inbox", sender_addr: "x@y.z", unread: true, starred: false,
	has_attachment: false, can_unsubscribe: false, labels: [], date: "2026-10-09", thread_unread_count: 1, ...fields,
});
const F = (view, chips = []) => ({ view, chips, sort: "date", dir: "desc" });

test("optimistic updates move rows out of views they no longer match", () => {
	assert.equal(o.applyAction(row(), { type: "archive" }, F("inbox")), null);
	assert.equal(o.applyAction(row(), { type: "archive" }, F("all")).state, "archive");
	assert.equal(o.applyAction(row({ state: "archive" }), { type: "archive" }, F("all")).state, "archive");
	assert.equal(o.applyAction(row(), { type: "move", folder: "spam" }, F("all")), null);
	const read = o.applyAction(row(), { type: "read" }, F("inbox"));
	assert.equal(read.unread, false);
	assert.equal(read.thread_unread_count, 0);
	assert.equal(o.applyAction(row(), { type: "read" }, F("unread")), null);
});

test("optimistic label changes respect label chips", () => {
	const added = o.applyAction(row(), { type: "label_add", labelId: "tax" }, F("inbox"));
	assert.deepEqual(added.labels, ["tax"]);
	assert.deepEqual(o.applyAction(added, { type: "label_add", labelId: "tax" }, F("inbox")).labels, ["tax"]);
	assert.equal(o.applyAction(row({ labels: ["tax"] }), { type: "label_remove", labelId: "tax" }, F("inbox", [{ kind: "label", value: "tax" }])), null);
	assert.deepEqual(o.applyAction(row({ labels: ["tax", "work"] }), { type: "label_remove", labelId: "tax" }, F("inbox")).labels, ["work"]);
});

test("Read marks read unless every target is read", () => {
	assert.deepEqual(o.readToggle([{ thread_unread_count: 0 }, { thread_unread_count: 2 }]), { type: "read" });
	assert.deepEqual(o.readToggle([{ thread_unread_count: 0 }, { thread_unread_count: 0 }]), { type: "unread" });
	assert.deepEqual(o.readToggle([]), { type: "read" });
	assert.deepEqual(o.readToggle([], { unread: 0 }), { type: "unread" });
	assert.deepEqual(o.readToggle([{ thread_unread_count: 0 }], { unread: 4 }), { type: "read" });
});

test("Star stars unless every target is starred", () => {
	assert.deepEqual(o.starToggle([{ starred: true }, { starred: false }]), { type: "star" });
	assert.deepEqual(o.starToggle([{ starred: true }, { starred: true }]), { type: "unstar" });
	assert.deepEqual(o.starToggle([]), { type: "star" });
});

test("Move to leaves out the folder the view already moves from", () => {
	assert.deepEqual(o.moveTargets("inbox"), ["archive", "spam", "trash"]);
	assert.deepEqual(o.moveTargets("unread"), ["archive", "spam", "trash"]);
	assert.deepEqual(o.moveTargets("starred"), ["archive", "spam", "trash"]);
	assert.deepEqual(o.moveTargets("archive"), ["inbox", "spam", "trash"]);
	assert.deepEqual(o.moveTargets("spam"), ["inbox", "archive", "trash"]);
	assert.deepEqual(o.moveTargets("trash"), ["inbox", "archive", "spam"]);
	assert.deepEqual(o.moveTargets("sent"), ["inbox", "archive", "spam", "trash"]);
});
