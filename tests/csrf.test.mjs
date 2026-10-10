import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTs } from "./helpers/sqlite.mjs";

const { app } = await loadTs("workers/index.ts");

const calls = [];
function environment() {
	return {
		EMAIL_ADDRESSES: ["a@wayne.org"],
		BUCKET: {
			head: async () => ({}),
			delete: async (keys) => calls.push(["r2.delete", keys]),
			list: async () => ({ objects: [{ key: "mailboxes/a@wayne.org.json" }] }),
		},
		MAILBOX: {
			idFromName: (name) => name,
			get: () => ({
				trashOrDelete: async (id) => (calls.push(["trashOrDelete", id]), id === "missing" ? null
					: id === "in-trash" ? { action: "deleted", attachments: [{ id: "att", filename: "f.pdf" }] }
					: { action: "trashed", attachments: [] }),
				deleteFolder: async (id) => ({ full: "not_empty", empty: "deleted" })[id] ?? "not_found",
			}),
		},
		MAIL_INDEX: {
			idFromName: (name) => name,
			get: () => ({
				startRebuild: async () => ({ generation: 1 }),
				queryMail: async (filter, options) => ({ filter, options, conversations: [] }),
			}),
		},
	};
}

const json = { "content-type": "application/json" };

async function post(headers) {
	return app.request("http://localhost/api/v1/index/rebuild", { method: "POST", headers, body: "{}" }, environment());
}

test("writes from the app itself pass", async () => {
	assert.equal((await post({ ...json, "sec-fetch-site": "same-origin" })).status, 202);
	assert.equal((await post({ ...json, "sec-fetch-site": "none" })).status, 202);
	assert.equal((await post({ ...json, origin: "http://localhost", "sec-fetch-site": "cross-site" })).status, 202);
});

test("cross-site and header-less writes are refused", async () => {
	assert.equal((await post({ ...json, "sec-fetch-site": "cross-site", origin: "https://evil.example" })).status, 403);
	assert.equal((await post({ ...json, "sec-fetch-site": "same-site" })).status, 403);
	assert.equal((await post({ ...json })).status, 403);
});

test("writes without a JSON content type are refused", async () => {
	assert.equal((await post({ "sec-fetch-site": "same-origin", "content-type": "text/plain" })).status, 415);
	assert.equal((await post({ "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" })).status, 415);
	assert.equal((await post({ "sec-fetch-site": "same-origin" })).status, 415);
});

test("reads are not checked", async () => {
	const response = await app.request("http://localhost/api/v1/mail?view=all", { headers: { "sec-fetch-site": "cross-site" } }, environment());
	assert.equal(response.status, 200);
});

const same = { ...json, "sec-fetch-site": "same-origin" };

test("Delete moves to Trash, and deletes attachments only on a permanent delete", async () => {
	calls.length = 0;
	let response = await app.request("http://localhost/api/v1/mailboxes/a@wayne.org/emails/e1", { method: "DELETE", headers: same }, environment());
	assert.deepEqual(await response.json(), { status: "trashed" });
	response = await app.request("http://localhost/api/v1/mailboxes/a@wayne.org/emails/in-trash", { method: "DELETE", headers: same }, environment());
	assert.deepEqual(await response.json(), { status: "deleted" });
	assert.deepEqual(calls, [["trashOrDelete", "e1"], ["trashOrDelete", "in-trash"], ["r2.delete", ["attachments/in-trash/att/f.pdf"]]]);
	response = await app.request("http://localhost/api/v1/mailboxes/a@wayne.org/emails/missing", { method: "DELETE", headers: same }, environment());
	assert.equal(response.status, 404);
});

test("deleting a folder that holds mail returns 409", async () => {
	const del = (id) => app.request(`http://localhost/api/v1/mailboxes/a@wayne.org/folders/${id}`, { method: "DELETE", headers: same }, environment());
	assert.equal((await del("full")).status, 409);
	assert.equal((await del("empty")).status, 204);
	assert.equal((await del("inbox")).status, 400);
});

test("mail params are validated before reaching the index", async () => {
	const get = (query) => app.request(`http://localhost/api/v1/mail?${query}`, {}, environment());
	assert.equal((await get("view=bogus")).status, 400);
	assert.equal((await get("cursor=@@@")).status, 400);
	const body = await (await get("view=all&address=billing&limit=10")).json();
	assert.deepEqual(body.filter.address, ["billing"]);
	assert.deepEqual(body.options, { cursor: null, limit: 10 });
});
