// Regression: toolbar buttons lost their accessible names below 768px
//
// The toolbar and top-bar buttons have no aria-label; their visible label is the name.
// Hiding it with display:none or visibility:hidden on narrow screens leaves icon-only
// buttons that a screen reader announces as "button". Hide it visually instead.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const css = readFileSync("app/index.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

test("toolbar labels stay in the accessibility tree at every width", () => {
	const offenders = [];
	for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
		const [, selector, body] = match;
		if (!selector.includes(".mail-tool-label")) continue;
		if (/\bdisplay\s*:\s*none\b|\bvisibility\s*:\s*hidden\b/.test(body)) offenders.push(selector.trim());
	}
	assert.deepEqual(offenders, []);
});
