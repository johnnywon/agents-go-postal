import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTs } from "./helpers/sqlite.mjs";

const { SHORTCUTS, KeyMatcher, cannotBind, cleanOverrides, keycaps, keyText, rebind, resolveBindings, stepOf, tidy, validStep } = await loadTs("shared/shortcuts.ts");

test("ids are unique and every default key is a valid step", () => {
	const ids = SHORTCUTS.map((s) => s.id);
	assert.equal(new Set(ids).size, ids.length);
	for (const s of SHORTCUTS) for (const k of s.keys) for (const step of k.split(" ")) assert.ok(validStep(step), `${s.id}: ${step}`);
});

test("no two shortcuts in a scope share a key by default", () => {
	const bindings = resolveBindings();
	for (const s of SHORTCUTS) assert.deepEqual(bindings.get(s.id), [...s.keys], s.id);
});

test("a key event becomes a step", () => {
	assert.equal(stepOf({ key: "E" , shiftKey: true }), "Shift+e");
	assert.equal(stepOf({ key: "e" }), "e");
	assert.equal(stepOf({ key: "?", shiftKey: true }), "?");
	assert.equal(stepOf({ key: "#", shiftKey: true }), "#");
	assert.equal(stepOf({ key: "k", metaKey: true }), "Mod+k");
	assert.equal(stepOf({ key: "K", ctrlKey: true, shiftKey: true }), "Mod+Shift+k");
	assert.equal(stepOf({ key: "Enter", metaKey: true }), "Mod+Enter");
	assert.equal(stepOf({ key: "ArrowDown", shiftKey: true }), "Shift+ArrowDown");
	assert.equal(stepOf({ key: " " }), "Space");
	assert.equal(stepOf({ key: "Shift", shiftKey: true }), null);
	assert.equal(stepOf({ key: "F5" }), null);
});

test("the matcher finds singles, sequences and Shift ranges", () => {
	const m = new KeyMatcher(resolveBindings());
	assert.deepEqual(m.match("e", 0), { id: "archive", shift: false });
	assert.deepEqual(m.match("Shift+x", 0), { id: "select", shift: true });
	assert.equal(m.match("Shift+e", 0), null);
	assert.equal(m.match("g", 0), "pending");
	assert.deepEqual(m.match("i", 500), { id: "goInbox", shift: false });
	assert.equal(m.match("g", 0), "pending");
	assert.equal(m.match("i", 1500), null);
	assert.deepEqual(m.match("Mod+j", 0), { id: "agent", shift: false });
	assert.equal(m.match("Mod+b", 0), null, "editor keys are not mail keys");
});

test("rebinding a key takes it from the shortcut that had it", () => {
	const overrides = rebind({}, "archive", ["s"]);
	assert.deepEqual(overrides, { archive: ["s"], star: [] });
	const bindings = resolveBindings(overrides);
	assert.deepEqual(bindings.get("archive"), ["s"]);
	assert.deepEqual(bindings.get("star"), []);
	const m = new KeyMatcher(bindings);
	assert.deepEqual(m.match("s", 0), { id: "archive", shift: false });
	assert.equal(m.match("e", 0), null);
	assert.deepEqual(tidy(rebind(overrides, "archive", ["e"])), { star: [] });
});

test("an override that clashes with a fixed key loses it", () => {
	const bindings = resolveBindings({ archive: ["Escape", "y"] });
	assert.deepEqual(bindings.get("archive"), ["y"]);
	assert.deepEqual(bindings.get("back"), ["Escape"]);
});

test("reserved and unusable keys can't be bound", () => {
	for (const k of ["g", "?", "Escape", "Tab", "Enter", "Alt+e", "E", "nonsense"]) assert.ok(cannotBind(k), k);
	for (const k of ["y", "Shift+y", "Mod+Shift+k", "Delete", "!", "1"]) assert.equal(cannotBind(k), null, k);
	assert.deepEqual(cleanOverrides({ archive: ["y", "y", "g", "q", "w"], help: ["h"] }), { archive: ["y", "q"] });
	assert.deepEqual(cleanOverrides("nope"), {});
});

test("keycaps follow the platform", () => {
	assert.deepEqual(keycaps("Mod+Enter", true), ["⌘", "↵"]);
	assert.deepEqual(keycaps("Mod+Enter", false), ["Ctrl", "↵"]);
	assert.deepEqual(keycaps("g i", true), ["G", "I"]);
	assert.deepEqual(keycaps("Shift+x", true), ["⇧", "X"]);
	assert.equal(keyText("Mod+k", true), "⌘K");
	assert.equal(keyText("Mod+k", false), "Ctrl+K");
	assert.equal(keyText("g i", false), "G I");
});

