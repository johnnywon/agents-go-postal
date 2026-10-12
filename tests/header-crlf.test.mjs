import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTs } from "./helpers/sqlite.mjs";

const { SendEmailRequestSchema, hasHeaderLineBreaks } = await loadTs("workers/lib/schemas.ts");
const base = {
	to: "hello@example.com",
	from: "sender@example.org",
	subject: "Hello",
	text: "Body",
};

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
