import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const bundle = await build({
	entryPoints: ["workers/lib/combined-inbox.ts"],
	bundle: true,
	platform: "node",
	format: "esm",
	write: false,
});
const { getCombinedInbox, InvalidInboxCursorError } = await import(
	`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);
const appBundle = await build({
	entryPoints: ["workers/index.ts"],
	bundle: true,
	platform: "node",
	format: "esm",
	write: false,
});
const { app } = await import(
	`data:text/javascript;base64,${Buffer.from(appBundle.outputFiles[0].text).toString("base64")}`
);

const addresses = ["a@wayne.org", "b@globex.dev"];
const messages = {
	"a@wayne.org": [9, 5, 4].map((n) => ({ id: `a-${n}`, date: `2026-09-${String(n).padStart(2, "0")}T00:00:00Z` })),
	"b@globex.dev": [8, 7, 6].map((n) => ({ id: `b-${n}`, date: `2026-09-${String(n).padStart(2, "0")}T00:00:00Z` })),
};

function environment() {
	return {
		EMAIL_ADDRESSES: addresses,
		BUCKET: {
			list: async () => ({ objects: [...addresses, "unconfigured@example.com"].map((email) => ({ key: `mailboxes/${email}.json` })) }),
		},
		MAILBOX: {
			idFromName: (address) => address,
			get: (address) => ({
				getThreadedEmails: async ({ folder, offset, limit }) => {
					assert.equal(folder, "inbox");
					return messages[address].slice(offset, offset + limit);
				},
				countThreadedEmails: async () => messages[address].length,
			}),
		},
	};
}

test("combined inbox paginates across mailboxes without losing rows", async () => {
	const env = environment();
	const first = await getCombinedInbox(env, undefined, 2);
	const second = await getCombinedInbox(env, first.nextCursor, 2);
	const third = await getCombinedInbox(env, second.nextCursor, 2);

	assert.deepEqual(
		[first, second, third].flatMap((page) => page.emails.map((email) => `${email.mailboxId}:${email.id}`)),
		["a@wayne.org:a-9", "b@globex.dev:b-8", "b@globex.dev:b-7", "b@globex.dev:b-6", "a@wayne.org:a-5", "a@wayne.org:a-4"],
	);
	assert.equal(first.totalCount, 6);
	assert.equal(third.nextCursor, null);
});

test("combined inbox rejects a malformed cursor", async () => {
	await assert.rejects(getCombinedInbox(environment(), "not-base64", 2), InvalidInboxCursorError);
});

test("combined inbox API returns a merged list and rejects invalid cursors", async () => {
	const env = environment();
	const response = await app.request("http://localhost/api/v1/inbox", {}, env);
	assert.equal(response.status, 200);
	const data = await response.json();
	assert.equal(data.totalCount, 6);
	assert.deepEqual(data.emails.map((email) => email.id), ["a-9", "b-8", "b-7", "b-6", "a-5", "a-4"]);
	const invalid = await app.request("http://localhost/api/v1/inbox?cursor=bad", {}, env);
	assert.equal(invalid.status, 400);
});
