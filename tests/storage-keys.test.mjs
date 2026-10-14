import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const files = execSync("git ls-files app shared", { encoding: "utf8" }).trim().split("\n");

test("no agp- storage key is used", () => {
	const hits = files.filter((f) => /\.(ts|tsx)$/.test(f) && /["'`]agp-/.test(readFileSync(f, "utf8")));
	assert.deepEqual(hits, []);
});

test("omr- keys and classes appear only as the keys being migrated", () => {
	const hits = files.filter((f) => /\.(ts|tsx|css)$/.test(f) && /["'`.]omr-(?!prefs"|layout"|shortcuts-seen")/.test(readFileSync(f, "utf8")));
	assert.deepEqual(hits, []);
});

test("omr- prefs keys are migrated, not dropped", () => {
	const prefs = readFileSync("app/components/postal/prefs.ts", "utf8");
	for (const key of ["omr-prefs", "omr-layout", "omr-shortcuts-seen"]) assert.ok(prefs.includes(`"${key}": `), key);
	assert.match(prefs, /^migrateStorageKeys\(\);$/m);
});
