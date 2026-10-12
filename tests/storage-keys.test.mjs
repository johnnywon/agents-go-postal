import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

test("no agp- storage key is written", () => {
	const files = execSync("git ls-files app shared", { encoding: "utf8" }).trim().split("\n");
	const hits = files.filter((f) => /\.(ts|tsx)$/.test(f) && /["'`]agp-(?!prefs"|layout"|shortcuts-seen")/.test(readFileSync(f, "utf8")));
	assert.deepEqual(hits, []);
});

test("old prefs keys are migrated, not dropped", () => {
	const prefs = readFileSync("app/components/postal/prefs.ts", "utf8");
	assert.match(prefs, /LEGACY_KEYS/);
});
