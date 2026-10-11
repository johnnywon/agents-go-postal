import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// The frame is sized from body.scrollHeight. Without its own formatting context, the first
// child's top margin and the last child's bottom margin collapse through <body> and are left
// out of that height, so mail that opens with a heading is cut off at the bottom.
test("a message frame keeps its children's margins inside the measured body", () => {
	const source = readFileSync("app/components/EmailIframe.tsx", "utf8");
	const body = source.match(/\nbody \{([\s\S]*?)\n\}/)?.[1] ?? "";
	assert.match(body, /display:\s*flow-root/);
	assert.match(source, /document\.body\.scrollHeight/);
});
