import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTs } from "./helpers/sqlite.mjs";

const { app } = await loadTs("workers/index.ts");

async function config(env) {
	return (await app.request("http://localhost/api/v1/config", {}, { DOMAINS: "example.com", EMAIL_ADDRESSES: [], ...env })).json();
}

test("config lists domains and addresses; agents can run on new mail outside a demo", async () => {
	assert.deepEqual(await config({ DOMAINS: "example.com, example.org", EMAIL_ADDRESSES: ["a@example.com"] }), {
		domains: ["example.com", "example.org"], emailAddresses: ["a@example.com"], autoDraft: true, demo: false,
	});
});

test("the dev seed route does not exist outside local development", async () => {
	const response = await app.request("http://localhost/api/v1/dev/seed", {
		method: "POST",
		headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
		body: "{}",
	}, {});
	assert.equal(response.status, 404);
});
