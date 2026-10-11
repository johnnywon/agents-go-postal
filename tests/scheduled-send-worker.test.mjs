import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

// End to end in local workerd: a scheduled send waits as a draft and the mailbox alarm sends it.

const MAILBOX = "a@example.com";
let mf;

before(async () => {
	const bundle = await build({
		entryPoints: ["tests/fixtures/index-worker.ts"],
		bundle: true,
		format: "esm",
		platform: "neutral",
		conditions: ["workerd", "worker", "browser"],
		mainFields: ["module", "main"],
		external: ["cloudflare:workers"],
		write: false,
		logLevel: "silent",
	});
	mf = new Miniflare({
		modules: true,
		script: bundle.outputFiles[0].text,
		compatibilityDate: "2025-11-28",
		compatibilityFlags: ["nodejs_compat"],
		bindings: { EMAIL_ADDRESSES: [MAILBOX], INDEX_SYNC_ENABLED: "false" },
		email: { send_email: [{ name: "EMAIL" }] },
		r2Buckets: ["BUCKET"],
		durableObjects: {
			MAILBOX: { className: "MailboxDO", useSQLite: true },
			MAIL_INDEX: { className: "MailIndexDO", useSQLite: true },
		},
	});
});

after(async () => {
	await mf?.dispose();
});

async function call(target, op, ...args) {
	const response = await mf.dispatchFetch("http://test/", { method: "POST", body: JSON.stringify({ target, op, args }) });
	return response.json();
}

async function ok(target, op, ...args) {
	const result = await call(target, op, ...args);
	assert.equal(result.error, undefined, `${target}.${op}: ${result.error}`);
	return result.ok;
}

async function waitFor(check, label) {
	for (let i = 0; i < 100; i++) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	assert.fail(`timed out waiting for ${label}`);
}

const message = (fields = {}) => ({
	to: "bob@example.org", from: MAILBOX, subject: "Later", html: "<p>Sent later</p>", ...fields,
});

test("the alarm sends a due scheduled message and deletes its draft", async () => {
	await ok("bucket", "put", MAILBOX);
	await ok(MAILBOX, "setMailboxId", MAILBOX);

	// A pending send far in the future stays put.
	const later = await ok(MAILBOX, "scheduleSend", {
		sendAt: new Date(Date.now() + 3_600_000).toISOString(), mode: "new", email: message({ subject: "Next hour" }),
	});
	// The DO method trusts the route's validation, so a past time is due at once.
	const due = await ok(MAILBOX, "scheduleSend", {
		sendAt: new Date(Date.now() - 1_000).toISOString(), mode: "new", email: message(),
	});
	assert.equal((await ok(MAILBOX, "getEmail", due.id)).folder_id, "draft");

	await waitFor(async () => (await ok(MAILBOX, "getEmail", due.id)) === null, "due draft to be sent");
	const sent = await ok(MAILBOX, "getEmails", { folder: "sent" });
	assert.deepEqual(sent.map((e) => e.subject), ["Later"]);
	assert.equal(sent[0].recipient, "bob@example.org");
	// The alarm sends under the draft's key, so the UI or agent sending the same draft gets the first send back.
	assert.deepEqual(await ok(MAILBOX, "claimSendKey", `draft:${due.id}`), { state: "sent", id: sent[0].id });

	const pending = await ok(MAILBOX, "listScheduled");
	assert.deepEqual(pending.map((row) => row.emailId), [later.id]);
	assert.equal((await ok(MAILBOX, "getEmail", later.id)).folder_id, "draft");
});

test("replacing a draft and cancelling a schedule", async () => {
	const first = await ok(MAILBOX, "scheduleSend", {
		sendAt: new Date(Date.now() + 3_600_000).toISOString(), mode: "new", email: message({ subject: "v1" }),
	});
	const second = await ok(MAILBOX, "scheduleSend", {
		sendAt: new Date(Date.now() + 3_600_000).toISOString(), draftId: first.id, mode: "new", email: message({ subject: "v2" }),
	});
	assert.equal(await ok(MAILBOX, "getEmail", first.id), null);
	assert.equal((await ok(MAILBOX, "getEmail", second.id)).subject, "v2");
	assert.ok(!(await ok(MAILBOX, "listScheduled")).some((row) => row.emailId === first.id));

	assert.equal(await ok(MAILBOX, "cancelScheduled", second.id), true);
	assert.equal(await ok(MAILBOX, "cancelScheduled", second.id), false);
	assert.equal((await ok(MAILBOX, "getEmail", second.id)).folder_id, "draft");
});

test("a scheduled reply threads with the original", async () => {
	const original = {
		id: "orig-1", subject: "Question", sender: "bob@example.org", recipient: MAILBOX, date: new Date().toISOString(),
		body: "<p>?</p>", thread_id: "thread-1", message_id: "orig-1@example.org",
	};
	await ok(MAILBOX, "createEmail", "inbox", original, []);
	const draft = await ok(MAILBOX, "scheduleSend", {
		sendAt: new Date(Date.now() - 1_000).toISOString(), mode: "reply", originalId: original.id,
		email: message({ subject: "Re: Question" }),
	});
	const stored = await ok(MAILBOX, "getEmail", draft.id);
	assert.equal(stored.thread_id, "thread-1");
	assert.equal(stored.in_reply_to, "orig-1");

	await waitFor(async () => (await ok(MAILBOX, "getEmail", draft.id)) === null, "reply to be sent");
	const thread = await ok(MAILBOX, "getThreadEmails", "thread-1");
	const reply = thread.find((e) => e.folder_id === "sent");
	assert.equal(reply.in_reply_to, "orig-1@example.org");
	assert.equal(thread.find((e) => e.id === "orig-1").read, true);
});
