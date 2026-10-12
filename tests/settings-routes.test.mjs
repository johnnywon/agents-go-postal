import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { build } from "esbuild";
import { createStaticHandler } from "react-router";
import { loadTs } from "./helpers/sqlite.mjs";

const { settingsTabFrom, SETTINGS_TABS } = await loadTs("app/components/postal/settings-tabs.ts");

// The redirect route bundled as the app sees it, written under node_modules so it shares this test's react-router.
const bundle = await build({
	entryPoints: ["app/routes/settings-redirect.tsx"], bundle: true, platform: "node", format: "esm", write: false,
	jsx: "automatic", packages: "external", alias: { "~": "./app" },
});
const out = "node_modules/.cache/agp-tests/settings-redirect.mjs";
mkdirSync("node_modules/.cache/agp-tests", { recursive: true });
writeFileSync(out, bundle.outputFiles[0].text);
const redirect = await import(new URL(`../${out}`, import.meta.url).href);

test("?settings= names a tab, and the old index name means Storage", () => {
	for (const tab of SETTINGS_TABS) assert.equal(settingsTabFrom(tab), tab);
	assert.equal(settingsTabFrom("index"), "storage");
	assert.equal(settingsTabFrom(null), null);
	assert.equal(settingsTabFrom(""), null);
	assert.equal(settingsTabFrom("nope"), null);
});

test("the old settings pages redirect to their tabs", async () => {
	const handler = createStaticHandler([
		{ id: "labels", path: "/settings", loader: redirect.loader },
		{ id: "storage", path: "/settings/index", loader: redirect.loader },
	]);
	for (const [path, to] of [["/settings", "/?settings=labels"], ["/settings/", "/?settings=labels"], ["/settings/index", "/?settings=storage"]]) {
		const res = await handler.query(new Request(`http://localhost${path}`));
		assert.ok(res instanceof Response, `${path} redirects`);
		assert.equal(res.status, 302);
		assert.equal(res.headers.get("location"), to);
	}
});
