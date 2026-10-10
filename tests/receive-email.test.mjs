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

async function deliveredMailbox(envelopeTo, headers) {
	const raw = new TextEncoder().encode(
		`From: sender@example.net\r\n${headers}\r\nSubject: Routing test\r\n\r\nHello`,
	);
	const lookedUp = [];
	await receiveEmail(
		{
			to: envelopeTo,
			rawSize: raw.length,
			raw: new ReadableStream({ start(controller) { controller.enqueue(raw); controller.close(); } }),
		},
		{
			EMAIL_ADDRESSES: ["hello@wayne.org", "support@globex.dev"],
			BUCKET: { head: async (key) => { lookedUp.push(key); return null; } },
		},
		{},
	);
	return lookedUp;
}

test("a delivery to the second To address reaches its own mailbox", async () => {
	assert.deepEqual(
		await deliveredMailbox("support@globex.dev", "To: hello@wayne.org, support@globex.dev"),
		["mailboxes/support@globex.dev.json"],
	);
});

test("a Bcc delivery reaches its envelope mailbox", async () => {
	assert.deepEqual(
		await deliveredMailbox("support@globex.dev", "To: someone@example.net"),
		["mailboxes/support@globex.dev.json"],
	);
});

test("an unconfigured envelope recipient is ignored", async () => {
	assert.deepEqual(
		await deliveredMailbox("other@example.net", "To: hello@wayne.org"),
		[],
	);
});

test("an inbound message triggers the receiving agent through RPC", async () => {
	const raw = new TextEncoder().encode(
		"From: sender@example.net\r\nTo: jane@acme.com\r\nSubject: Draft me\r\n\r\nHello",
	);
	let savedEmail;
	let agentInput;
	const background = [];
	const mailbox = {
		findThreadBySubject: async () => null,
		createEmail: async (_folder, email) => { savedEmail = email; },
	};
	const agent = {
		fetch: async () => { throw new Error("Direct agent fetch is unsupported"); },
		handleNewEmail: async (input) => { agentInput = input; },
	};
	await receiveEmail(
		{
			to: "jane@acme.com",
			rawSize: raw.length,
			raw: new ReadableStream({ start(controller) { controller.enqueue(raw); controller.close(); } }),
		},
		{
			AUTO_DRAFT_ENABLED: "true",
			EMAIL_ADDRESSES: ["jane@acme.com"],
			BUCKET: { head: async () => ({}) },
			MAILBOX: { idFromName: (name) => name, get: () => mailbox },
			EMAIL_AGENT: { idFromName: (name) => name, get: () => agent },
		},
		{ waitUntil: (promise) => background.push(promise) },
	);
	await Promise.all(background);
	assert.equal(savedEmail.subject, "Draft me");
	assert.deepEqual(agentInput, {
		mailboxId: "jane@acme.com",
		emailId: savedEmail.id,
		sender: "sender@example.net",
		subject: "Draft me",
		threadId: savedEmail.thread_id,
	});
});

test("inbound mail is saved without triggering the agent when auto-drafting is off", async () => {
	const raw = new TextEncoder().encode(
		"From: sender@example.net\r\nTo: jane@acme.com\r\nSubject: No automatic draft\r\n\r\nHello",
	);
	let savedEmail;
	const background = [];
	await receiveEmail(
		{
			to: "jane@acme.com",
			rawSize: raw.length,
			raw: new ReadableStream({ start(controller) { controller.enqueue(raw); controller.close(); } }),
		},
		{
			AUTO_DRAFT_ENABLED: "false",
			EMAIL_ADDRESSES: ["jane@acme.com"],
			BUCKET: { head: async () => ({}) },
			MAILBOX: {
				idFromName: (name) => name,
				get: () => ({
					findThreadBySubject: async () => null,
					createEmail: async (_folder, email) => { savedEmail = email; },
				}),
			},
			EMAIL_AGENT: { idFromName: () => { throw new Error("Agent must not be called"); } },
		},
		{ waitUntil: (promise) => background.push(promise) },
	);
	assert.equal(savedEmail.subject, "No automatic draft");
	assert.equal(background.length, 0);
});
