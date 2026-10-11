import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTs } from "./helpers/sqlite.mjs";

import { readFileSync } from "node:fs";

const { shortcutFor, SHORTCUT_KEYS } = await loadTs("app/hooks/useMailShortcuts.ts");

// Minimal element stand-in: closest() matches by the selectors the hook asks for.
function el(kind) {
	return { closest: (selector) => (selector.includes(kind) ? {} : null) };
}

test("plain keys map to shortcuts", () => {
	assert.equal(shortcutFor({ key: "j", target: el("div") }), "next");
	assert.equal(shortcutFor({ key: "k", target: el("div") }), "previous");
	assert.equal(shortcutFor({ key: "/", target: el("div") }), "search");
	assert.equal(shortcutFor({ key: "?", target: el("div") }), "keys");
	assert.equal(shortcutFor({ key: "x", target: el("div") }), "select");
	assert.equal(shortcutFor({ key: "l", target: el("div") }), "label");
	assert.equal(shortcutFor({ key: "e", target: el("div") }), "archive");
	assert.equal(shortcutFor({ key: "#", target: el("div") }), "delete");
	assert.equal(shortcutFor({ key: "s", target: el("div") }), "star");
	assert.equal(shortcutFor({ key: "u", target: el("div") }), "read");
	assert.equal(shortcutFor({ key: "q", target: el("div") }), null);
});

test("typing, IME, modifiers, dialogs and handled events are ignored", () => {
	assert.equal(shortcutFor({ key: "j", target: el("input") }), null);
	assert.equal(shortcutFor({ key: "e", target: el("input") }), null);
	assert.equal(shortcutFor({ key: "#", target: el("textarea") }), null);
	assert.equal(shortcutFor({ key: "j", target: el("textarea") }), null);
	assert.equal(shortcutFor({ key: "j", target: el("contenteditable") }), null);
	assert.equal(shortcutFor({ key: "j", target: el("role='dialog'") }), null);
	assert.equal(shortcutFor({ key: "j", target: el("data-mail-popover") }), null);
	assert.equal(shortcutFor({ key: "j", isComposing: true }), null);
	assert.equal(shortcutFor({ key: "j", metaKey: true }), null);
	assert.equal(shortcutFor({ key: "j", ctrlKey: true }), null);
	assert.equal(shortcutFor({ key: "j", altKey: true }), null);
	assert.equal(shortcutFor({ key: "j", defaultPrevented: true }), null);
});

test("Escape passes even from a field", () => {
	assert.equal(shortcutFor({ key: "Escape", target: el("input") }), "escape");
});

// The postal view also uses r (reply), a (reply all), f (forward), c (compose) and z (undo).
const POSTAL_KEYS = ["r", "a", "f", "c", "z"];

test("a message frame forwards every shortcut key", () => {
	const source = readFileSync("app/components/EmailIframe.tsx", "utf8");
	const list = source.match(/if \((\[[^\]]*\])\.indexOf\(e\.key\) < 0\) return;/);
	assert.ok(list, "key list in the frame script");
	assert.deepEqual(JSON.parse(list[1]).sort(), [...new Set([...SHORTCUT_KEYS, ...POSTAL_KEYS])].sort());
});
