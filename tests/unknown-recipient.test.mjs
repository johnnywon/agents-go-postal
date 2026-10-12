import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const bundle = await build({
	entryPoints: ["workers/index.ts"],
	bundle: true,
	platform: "node",
	format: "esm",
	write: false,
});
const { receiveEmail } = await import(
	`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);

function message() {
	const raw = new TextEncoder().encode("From: sender@example.net\r\nTo: hello@example.com\r\nSubject: Routing test\r\n\r\nHello");
	let reads = 0;
	return {
		rawSize: raw.length,
		raw: new ReadableStream({
			pull(controller) {
				reads++;
				controller.enqueue(raw);
				controller.close();
			},
		}, { highWaterMark: 0 }),
		get reads() { return reads; },
	};
}

function environment(addresses, mailboxExists = false) {
	const calls = [];
	const objects = new Map();
	return {
		calls,
		env: {
			EMAIL_ADDRESSES: addresses,
			BUCKET: {
				head: async (key) => mailboxExists || objects.has(key) ? {} : null,
				put: async (key, value) => objects.set(key, value),
			},
			MAILBOX: {
				idFromName: (name) => name,
				get: (id) => ({
					setMailboxId: async () => {},
					hasInboundMessageId: async () => false,
					findThreadBySubject: async () => null,
					createEmail: async (_folder, email) => calls.push([id, email.subject]),
				}),
			},
		},
	};
}

test("unknown envelope recipients are rejected before reading the message", async () => {
	const unconfigured = environment(["allowed@example.com"]);
	const unconfiguredMessage = message();
	const unconfiguredRejections = [];
	await receiveEmail({
		to: "other@example.net",
		...unconfiguredMessage,
		setReject: (reason) => unconfiguredRejections.push(reason),
	}, unconfigured.env, { waitUntil: () => {} });
	assert.deepEqual(unconfiguredRejections, ["Unknown recipient"]);
	assert.equal(unconfiguredMessage.reads, 0);
	assert.deepEqual(unconfigured.calls, []);

	const missingMailbox = environment([]);
	const missingMailboxMessage = message();
	const missingMailboxRejections = [];
	await receiveEmail({
		to: "unknown@example.org",
		...missingMailboxMessage,
		setReject: (reason) => missingMailboxRejections.push(reason),
	}, missingMailbox.env, { waitUntil: () => {} });
	assert.deepEqual(missingMailboxRejections, ["Unknown recipient"]);
	assert.equal(missingMailboxMessage.reads, 0);
	assert.deepEqual(missingMailbox.calls, []);

	const configured = environment(["hello@example.com"]);
	const configuredMessage = message();
	const configuredRejections = [];
	await receiveEmail({
		to: "hello@example.com",
		...configuredMessage,
		setReject: (reason) => configuredRejections.push(reason),
	}, configured.env, { waitUntil: () => {} });
	assert.deepEqual(configuredRejections, []);
	assert.equal(configured.calls.length, 1);
});
