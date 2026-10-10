import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

async function load(entry, options = {}) {
	const bundle = await build({
		entryPoints: [entry],
		bundle: true,
		platform: "node",
		format: "esm",
		write: false,
		tsconfig: "tsconfig.cloudflare.json",
		...options,
	});
	return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
}

const { parseAddressList, getReplyToAddresses, getReplyAddresses, extractReplyQuote } = await load("app/lib/reply.ts");

// The compose form's React hooks and UI kit are stubbed; only the pure field builder runs.
const stubs = {
	"@cloudflare/kumo": "export const useKumoToastManager = () => ({ add() {} });",
	"~/queries/emails":
		"const h = () => ({}); export const useDeleteEmail = h, useForwardEmail = h, useReplyToEmail = h, useSaveDraft = h, useSendEmail = h;",
	"~/queries/mailboxes": "export const useMailbox = () => ({});",
};
const { buildInitialComposeFields } = await load("app/hooks/useComposeForm.ts", {
	jsx: "automatic",
	plugins: [
		{
			name: "stub-ui",
			setup(b) {
				b.onResolve({ filter: /^(@cloudflare\/kumo|~\/queries\/(emails|mailboxes))$/ }, (args) => ({
					path: args.path,
					namespace: "stub",
				}));
				b.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ contents: stubs[args.path], loader: "js" }));
			},
		},
	],
});

const postalHeaders = (value) =>
	JSON.stringify([
		{ key: "from", originalKey: "From", value: "Globex.dev <news@updates.globex.dev>" },
		{ key: "reply-to", originalKey: "Reply-To", value },
	]);

test("parses address lists with names, quoted commas and duplicates", () => {
	assert.deepEqual(parseAddressList("Alex Reader <alex@example.com>"), ["alex@example.com"]);
	assert.deepEqual(parseAddressList('"Reader, Alex" <alex@example.com>, b@example.org'), ["alex@example.com", "b@example.org"]);
	assert.deepEqual(parseAddressList("a@example.com, A@Example.com"), ["a@example.com"]);
	assert.deepEqual(parseAddressList("not an address, <broken@>"), []);
});

test("reads Reply-To from stored headers in array or object form", () => {
	assert.deepEqual(getReplyToAddresses(postalHeaders("Alex <alex@example.com>")), ["alex@example.com"]);
	assert.deepEqual(getReplyToAddresses(JSON.stringify({ "Reply-To": "alex@example.com" })), ["alex@example.com"]);
	assert.deepEqual(getReplyToAddresses(JSON.stringify([{ name: "REPLY-TO", value: "a@example.com, b@example.com" }])), ["a@example.com", "b@example.com"]);
	assert.deepEqual(getReplyToAddresses(null), []);
	assert.deepEqual(getReplyToAddresses("not json"), []);
	assert.deepEqual(getReplyToAddresses(JSON.stringify([{ key: "from", value: "a@example.com" }])), []);
});

test("replies go to Reply-To when present and to the sender otherwise", () => {
	assert.deepEqual(getReplyAddresses({ sender: "news@updates.globex.dev", raw_headers: postalHeaders("alex@example.com") }), ["alex@example.com"]);
	assert.deepEqual(getReplyAddresses({ sender: "news@updates.globex.dev", raw_headers: null }), ["news@updates.globex.dev"]);
});

test("extracts the marked quote with line breaks and decoded entities", () => {
	const html = '<table><tr><td>Sender</td><td data-reply-quote="message" style="x">How do I filter?<br>Line two &amp; &lt;b&gt;more&lt;/b&gt;<br><br>Thanks</td></tr></table>';
	assert.equal(extractReplyQuote(html), "How do I filter?\nLine two & <b>more</b>\n\nThanks");
	assert.equal(extractReplyQuote("<p>No marker</p>"), null);
	assert.equal(extractReplyQuote(null), null);
	assert.equal(extractReplyQuote("<td data-reply-quote></td>"), null);
	// A visitor's text cannot add a marker: it arrives escaped.
	assert.equal(extractReplyQuote("<td>&lt;td data-reply-quote&gt;fake&lt;/td&gt;</td>"), null);
	// Each entity is decoded once.
	assert.equal(extractReplyQuote("<td data-reply-quote>&amp;lt;</td>"), "&lt;");
});

const inquiry = {
	id: "m1",
	sender: "news@updates.globex.dev",
	recipient: "hello@globex.dev",
	subject: "Globex.dev inquiry: Media",
	date: "2026-10-08T14:26:51.000Z",
	raw_headers: postalHeaders("Alex Reader <alex@example.com>"),
	body: '<div>Media</div><table><tr><td data-reply-quote="message">How do I filter?<br>Line two &amp; more</td></tr></table><table><tr><td>Reference CONTACT-1 Ray ID abc</td></tr></table>',
};

test("Reply on an inquiry addresses the visitor and quotes only their message", () => {
	const fields = buildInitialComposeFields({ mode: "reply", originalEmail: inquiry }, "hello@globex.dev", "");
	assert.equal(fields.to, "alex@example.com");
	assert.equal(fields.subject, "Re: Globex.dev inquiry: Media");
	assert.match(fields.body, /alex@example\.com wrote:/);
	assert.match(fields.body, /How do I filter\?<br>Line two &amp; more/);
	assert.doesNotMatch(fields.body, /CONTACT-1|Ray ID|news@updates/);
});

test("Reply All on an inquiry leaves out the mailbox itself", () => {
	const fields = buildInitialComposeFields({ mode: "reply-all", originalEmail: inquiry }, "hello@globex.dev", "");
	assert.equal(fields.to, "alex@example.com");
	assert.equal(fields.cc, "");
});

test("Reply without Reply-To or a marker behaves as before", () => {
	const plain = { ...inquiry, raw_headers: null, sender: "sam@example.net", body: "<p>Hello there</p>" };
	const fields = buildInitialComposeFields({ mode: "reply", originalEmail: plain }, "hello@globex.dev", "");
	assert.equal(fields.to, "sam@example.net");
	assert.match(fields.body, /sam@example\.net wrote:/);
	assert.match(fields.body, /Hello there/);
});

test("Reply with Reply-To but no marker still quotes the whole message, attributed to the sender", () => {
	const unmarked = { ...inquiry, body: "<p>Name: Alex Topic: Media</p>" };
	const fields = buildInitialComposeFields({ mode: "reply", originalEmail: unmarked }, "hello@globex.dev", "");
	assert.equal(fields.to, "alex@example.com");
	assert.match(fields.body, /news@updates\.globex\.dev wrote:/);
	assert.match(fields.body, /Name: Alex Topic: Media/);
});
