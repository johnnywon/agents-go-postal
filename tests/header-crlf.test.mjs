import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTs } from "./helpers/sqlite.mjs";

const { SendEmailRequestSchema, hasHeaderLineBreaks } = await loadTs("workers/lib/schemas.ts");
const { app } = await loadTs("workers/index.ts");
const base = {
	to: "hello@example.com",
	from: "sender@example.org",
	subject: "Hello",
	text: "Body",
};
const MAILBOX = "hello@example.com";

function routeEnvironment(calls = []) {
	return {
		EMAIL_ADDRESSES: [MAILBOX],
		BUCKET: { head: async () => ({}) },
		MAILBOX: {
			idFromName: (name) => name,
			get: () => ({ createEmail: async (...args) => calls.push(args) }),
		},
	};
}

const jsonHeaders = { "content-type": "application/json", "sec-fetch-site": "same-origin" };

async function routePost(path, body, env) {
	return app.request(`http://localhost/api/v1/mailboxes/${MAILBOX}/${path}`, {
		method: "POST",
		headers: jsonHeaders,
		body: JSON.stringify(body),
	}, env);
}

test("outbound header fields reject CR, LF, and CRLF", () => {
	for (const [field, wrap] of [
		["subject", (value) => value],
		["in_reply_to", (value) => value],
		["thread_id", (value) => value],
		["references", (value) => [value]],
	]) {
		for (const newline of ["\r", "\n", "\r\n"]) {
			const parsed = SendEmailRequestSchema.safeParse({ ...base, [field]: wrap(`value${newline}injected`) });
			assert.equal(parsed.success, false, `${field} accepted ${JSON.stringify(newline)}`);
			assert.ok(parsed.error.issues.some((issue) => issue.message === "must not contain line breaks"));
		}
	}
});

test("outbound header length and references limits are enforced", () => {
	assert.equal(SendEmailRequestSchema.safeParse({ ...base, subject: "x".repeat(999) }).success, false);
	assert.equal(SendEmailRequestSchema.safeParse({ ...base, in_reply_to: "x".repeat(999) }).success, false);
	assert.equal(SendEmailRequestSchema.safeParse({ ...base, thread_id: "x".repeat(999) }).success, false);
	assert.equal(SendEmailRequestSchema.safeParse({ ...base, references: Array(101).fill("id@example.net") }).success, false);
});

test("the send-time guard catches line breaks in all delivered header values", () => {
	for (const newline of ["\r", "\n", "\r\n"]) {
		assert.equal(hasHeaderLineBreaks(`Hello${newline}injected`), true);
		assert.equal(hasHeaderLineBreaks("Hello", `id${newline}injected`), true);
		assert.equal(hasHeaderLineBreaks("Hello", null, `ref${newline}injected`), true);
	}
	assert.equal(hasHeaderLineBreaks("Hello", "id@example.net", "ref@example.net"), false);
});

test("draft and send routes return 400 for CR/LF subjects", async () => {
	for (const [path, body] of [
		["drafts", { subject: "bad\r\nsubject", body: "Draft body" }],
		["emails", { ...base, subject: "bad\r\nsubject" }],
	]) {
		const response = await routePost(path, body, routeEnvironment());
		assert.equal(response.status, 400);
		assert.match((await response.json()).error, /must not contain line breaks/);
	}
});

test("the draft route still accepts a normal draft", async () => {
	const calls = [];
	const response = await routePost("drafts", { subject: "A safe subject", body: "Draft body" }, routeEnvironment(calls));
	assert.equal(response.status, 201);
	assert.equal((await response.json()).status, "draft");
	assert.equal(calls.length, 1);
});
