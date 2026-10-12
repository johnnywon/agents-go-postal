import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTs } from "./helpers/sqlite.mjs";

const { errorResponse } = await loadTs("workers/lib/error-page.ts");
const MESSAGE = "Invalid or expired Access token";

test("API clients get the Access error as plain text", async () => {
	const res = errorResponse(new Request("https://mail.example.com/api/v1/mail", { headers: { accept: "application/json" } }), 403, "Sign in again", MESSAGE);
	assert.equal(res.status, 403);
	assert.match(res.headers.get("content-type"), /^text\/plain/);
	assert.equal(await res.text(), MESSAGE);
});

test("browsers get a page that keeps the message word for word", async () => {
	const res = errorResponse(new Request("https://mail.example.com/", { headers: { accept: "text/html,application/xhtml+xml" } }), 403, "Sign in again", MESSAGE);
	assert.equal(res.status, 403);
	assert.match(res.headers.get("content-type"), /^text\/html/);
	const html = await res.text();
	assert.ok(html.includes(MESSAGE), "docs/setup.md quotes this message");
	assert.match(html, /<h1>Sign in again<\/h1>/);
	assert.doesNotMatch(html, /<script/i);
});

test("the page escapes what it prints", async () => {
	const res = errorResponse(new Request("https://mail.example.com/", { headers: { accept: "text/html" } }), 500, "<b>x</b>", "a & <script>");
	const html = await res.text();
	assert.ok(html.includes("&lt;b&gt;x&lt;/b&gt;"));
	assert.ok(html.includes("a &amp; &lt;script&gt;"));
});
