import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// Keys a message frame passes up to the mail view while focus is inside the message.
const FRAME_KEYS = ["j", "k", "/", "?", "Escape", "x", "l", "e", "#", "s", "u", "r", "a", "f", "c", "z"];

test("a message frame forwards every shortcut key", () => {
	const source = readFileSync("app/components/EmailIframe.tsx", "utf8");
	const list = source.match(/if \((\[[^\]]*\])\.indexOf\(e\.key\) < 0\) return;/);
	assert.ok(list, "key list in the frame script");
	assert.deepEqual(JSON.parse(list[1]).sort(), [...FRAME_KEYS].sort());
});
