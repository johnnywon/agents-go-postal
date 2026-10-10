import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTs } from "./helpers/sqlite.mjs";

const { app } = await loadTs("workers/index.ts");

async function config(env) {
	return (await app.request("http://localhost/api/v1/config", {}, { DOMAINS: "wayne.org", EMAIL_ADDRESSES: [], ...env })).json();
}

test("MAIL_UI selects the unified view only when set to unified", async () => {
	assert.equal((await config({})).mailUi, "classic");
	assert.equal((await config({ MAIL_UI: "classic" })).mailUi, "classic");
	assert.equal((await config({ MAIL_UI: "unified" })).mailUi, "unified");
});

test("the dev seed route does not exist outside local development", async () => {
	const response = await app.request("http://localhost/api/v1/dev/seed", {
		method: "POST",
		headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
		body: "{}",
	}, {});
	assert.equal(response.status, 404);
});
