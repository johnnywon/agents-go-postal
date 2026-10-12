import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTs } from "./helpers/sqlite.mjs";

const { parseTip, splitKeys } = await loadTs("app/components/postal/Tooltip.tsx");

test("a title's shortcut becomes keycaps", () => {
	assert.deepEqual(splitKeys("⌘↵"), ["⌘", "↵"]);
	assert.deepEqual(splitKeys("Esc"), ["Esc"]);
	assert.deepEqual(splitKeys("⌘⇧K"), ["⌘", "⇧", "K"]);
	assert.deepEqual(parseTip("Send (⌘↵)"), { label: "Send", keys: ["⌘", "↵"], hint: undefined });
});

test("text after a middle dot is the hint line", () => {
	assert.deepEqual(parseTip("Select (X) · shift-click for a range"), { label: "Select", keys: ["X"], hint: "shift-click for a range" });
	assert.deepEqual(parseTip("Label · Labels are shared", "More"), { label: "Label", keys: [], hint: "Labels are shared. More" });
});

test("long parentheses stay in the label", () => {
	assert.equal(parseTip("Archive (everything older than a year)").label, "Archive (everything older than a year)");
	assert.equal(parseTip("  "), null);
});

test("keys off a Mac and sequences split into keycaps", () => {
	assert.deepEqual(splitKeys("Ctrl+K"), ["Ctrl", "K"]);
	assert.deepEqual(splitKeys("Ctrl+⇧K"), ["Ctrl", "⇧", "K"]);
	assert.deepEqual(splitKeys("G I"), ["G", "I"]);
	assert.deepEqual(splitKeys("#"), ["#"]);
	assert.deepEqual(parseTip("Search (Ctrl+Shift+K)"), { label: "Search", keys: ["Ctrl", "Shift", "K"], hint: undefined });
});
