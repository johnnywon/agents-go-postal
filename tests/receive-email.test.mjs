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

function rawMessage(headers, subject = "Routing test") {
	const raw = new TextEncoder().encode(`From: sender@example.net\r\n${headers}\r\nSubject: ${subject}\r\n\r\nHello`);
	return { rawSize: raw.length, raw: new ReadableStream({ start(controller) { controller.enqueue(raw); controller.close(); } }) };
}

// A bucket with no mailboxes yet, and Durable Objects that record what they are asked to do.
function freshEnvironment(addresses) {
	const objects = new Map();
	const calls = [];
	return {
		calls,
		objects,
		env: {
			EMAIL_ADDRESSES: addresses,
			BUCKET: {
				head: async (key) => (calls.push(["head", key]), objects.has(key) ? {} : null),
				put: async (key, value) => { calls.push(["put", key]); objects.set(key, value); },
			},
			MAILBOX: {
				idFromName: (name) => name,
				get: (id) => ({
					setMailboxId: async (email) => calls.push(["setMailboxId", id, email]),
					findThreadBySubject: async () => null,
					createEmail: async (folder, email) => calls.push(["createEmail", id, folder, email.subject]),
				}),
			},
		},
	};
}

async function deliveredMailbox(envelopeTo, headers) {
	const { env, calls } = freshEnvironment(["hello@wayne.org", "support@globex.dev"]);
	await receiveEmail({ to: envelopeTo, ...rawMessage(headers) }, env, { waitUntil: () => {} });
	return calls.filter(([op]) => op === "createEmail").map(([, id]) => id);
}

test("a delivery to the second To address reaches its own mailbox", async () => {
	assert.deepEqual(
		await deliveredMailbox("support@globex.dev", "To: hello@wayne.org, support@globex.dev"),
		["support@globex.dev"],
	);
});

test("a Bcc delivery reaches its envelope mailbox", async () => {
	assert.deepEqual(
		await deliveredMailbox("support@globex.dev", "To: someone@example.net"),
		["support@globex.dev"],
	);
});

test("an unconfigured envelope recipient is ignored", async () => {
	assert.deepEqual(
		await deliveredMailbox("other@example.net", "To: hello@wayne.org"),
		[],
	);
});

test("the first delivery to a configured address creates its mailbox and keeps the message", async () => {
	const { env, calls, objects } = freshEnvironment(["hello@wayne.org"]);
	await receiveEmail({ to: "Hello@Wayne.org", ...rawMessage("To: hello@wayne.org", "Before anyone signed in") }, env, { waitUntil: () => {} });
	assert.deepEqual(JSON.parse(objects.get("mailboxes/hello@wayne.org.json")).fromName, "hello");
	assert.deepEqual(calls.filter(([op]) => op !== "head"), [
		["put", "mailboxes/hello@wayne.org.json"],
		["setMailboxId", "hello@wayne.org", "hello@wayne.org"],
		["createEmail", "hello@wayne.org", "inbox", "Before anyone signed in"],
	]);
});

test("a later delivery leaves the existing mailbox settings alone", async () => {
	const { env, calls, objects } = freshEnvironment(["hello@wayne.org"]);
	objects.set("mailboxes/hello@wayne.org.json", JSON.stringify({ fromName: "Custom" }));
	await receiveEmail({ to: "hello@wayne.org", ...rawMessage("To: hello@wayne.org") }, env, { waitUntil: () => {} });
	assert.equal(JSON.parse(objects.get("mailboxes/hello@wayne.org.json")).fromName, "Custom");
	assert.deepEqual(calls.filter(([op]) => op === "put" || op === "setMailboxId"), []);
});

test("without EMAIL_ADDRESSES, mail for a mailbox nobody created is ignored", async () => {
	const { env, calls } = freshEnvironment([]);
	await receiveEmail({ to: "anyone@wayne.org", ...rawMessage("To: anyone@wayne.org") }, env, { waitUntil: () => {} });
	assert.deepEqual(calls, [["head", "mailboxes/anyone@wayne.org.json"]]);
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
