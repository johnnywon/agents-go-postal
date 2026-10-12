import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTs } from "./helpers/sqlite.mjs";

const { settingsTabFrom, SETTINGS_TABS } = await loadTs("app/components/postal/settings-tabs.ts");

test("?settings= names a tab, and the old index name means Storage", () => {
	for (const tab of SETTINGS_TABS) assert.equal(settingsTabFrom(tab), tab);
	assert.equal(settingsTabFrom("index"), "storage");
	assert.equal(settingsTabFrom(null), null);
	assert.equal(settingsTabFrom(""), null);
	assert.equal(settingsTabFrom("nope"), null);
});
