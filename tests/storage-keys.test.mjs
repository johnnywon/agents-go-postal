import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

test("no agp- storage key is used", () => {
	const files = execSync("git ls-files app shared", { encoding: "utf8" }).trim().split("\n");
	const hits = files.filter((f) => /\.(ts|tsx)$/.test(f) && /["'`]agp-/.test(readFileSync(f, "utf8")));
	assert.deepEqual(hits, []);
});
