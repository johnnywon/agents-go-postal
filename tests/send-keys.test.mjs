import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTs, openDb } from "./helpers/sqlite.mjs";

const keys = await loadTs("workers/lib/send-keys.ts");
const { sendMail } = await loadTs("workers/lib/send.ts");
const { automatedMailReason } = await loadTs("workers/lib/message-meta.ts");
const { applyMigrations, mailboxMigrations } = await loadTs("workers/durableObject/migrations.ts");

const MAILBOX = "a@example.com";

function mailboxDb() {
	const { exec, transactionSync, sqlStorage } = openDb();
	applyMigrations(sqlStorage, mailboxMigrations, { transactionSync });
	return exec;
}

// -- Key table ---------------------------------------------------------

test("a key is claimed once, then reports the send that used it", () => {
	const exec = mailboxDb();
	assert.deepEqual(keys.claimSendKey(exec, "k1"), { state: "new" });
	assert.deepEqual(keys.claimSendKey(exec, "k1"), { state: "pending" });
	keys.finishSendKey(exec, "k1", "email-1");
	assert.deepEqual(keys.claimSendKey(exec, "k1"), { state: "sent", id: "email-1" });
});

test("a released key can be claimed again; a sent key cannot be released", () => {
	const exec = mailboxDb();
	keys.claimSendKey(exec, "k1");
	keys.releaseSendKey(exec, "k1");
	assert.deepEqual(keys.claimSendKey(exec, "k1"), { state: "new" });
	keys.finishSendKey(exec, "k1", "email-1");
	keys.releaseSendKey(exec, "k1");
	assert.deepEqual(keys.claimSendKey(exec, "k1"), { state: "sent", id: "email-1" });
});

test("keys expire after a week", () => {
	const exec = mailboxDb();
	const start = Date.parse("2026-10-01T00:00:00Z");
	keys.claimSendKey(exec, "old", start);
	keys.finishSendKey(exec, "old", "email-1");
	assert.deepEqual(keys.claimSendKey(exec, "old", start + keys.SEND_KEY_TTL_MS + 1), { state: "new" });
});

test("checkSendKey refuses empty and overlong keys", () => {
	assert.equal(keys.checkSendKey("abc"), null);
	assert.match(keys.checkSendKey("  "), /empty/);
	assert.match(keys.checkSendKey("x".repeat(keys.SEND_KEY_MAX_LENGTH + 1)), /longer/);
});

// -- sendMail with a key -------------------------------------------------

function harness({ rateLimit = null, failDelivery = 0, failStore = 0 } = {}) {
	const exec = mailboxDb();
	const delivered = [];
	const stored = [];
	const env = {
		EMAIL: {
			send: async (message) => {
				if (failDelivery > 0) { failDelivery--; throw new Error("delivery down"); }
				delivered.push(message);
				return { messageId: `m${delivered.length}` };
			},
		},
		BUCKET: { put: async () => {} },
	};
	const stub = {
		getEmail: async () => null,
		createEmail: async (_folder, email) => {
			if (failStore > 0) { failStore--; throw new Error("storage down"); }
			stored.push(email);
		},
		checkSendRateLimit: async () => rateLimit,
		markThreadRead: async () => {},
		claimSendKey: async (key) => keys.claimSendKey(exec, key),
		finishSendKey: async (key, id) => keys.finishSendKey(exec, key, id),
		releaseSendKey: async (key) => keys.releaseSendKey(exec, key),
	};
	const send = (key) =>
		sendMail(env, MAILBOX, stub, { to: "bob@example.org", from: MAILBOX, subject: "Hi", text: "Hello" }, { kind: "new" }, { idempotencyKey: key });
	return { send, delivered, stored, exec };
}

test("the same key sends once and returns the first send's id", async () => {
	const h = harness();
	const first = await h.send("k1");
	const second = await h.send("k1");
	assert.equal(first.ok, true);
	assert.deepEqual(second, { ok: true, id: first.id, duplicate: true });
	assert.equal(h.delivered.length, 1);
	assert.equal(h.stored.length, 1);
	assert.equal((await h.send("k2")).ok, true);
	assert.equal(h.delivered.length, 2);
});

test("a refused send releases its key", async () => {
	const h = harness({ rateLimit: "Rate limit exceeded" });
	assert.equal((await h.send("k1")).status, 429);
	assert.deepEqual(keys.claimSendKey(h.exec, "k1"), { state: "new" });
});

test("a failed delivery releases its key so a retry sends", async () => {
	const h = harness({ failDelivery: 1 });
	await assert.rejects(h.send("k1"), /delivery down/);
	assert.equal((await h.send("k1")).ok, true);
	assert.equal(h.delivered.length, 1);
});

test("a send that delivered but did not store keeps its key, and a retry is refused", async () => {
	const h = harness({ failStore: 1 });
	await assert.rejects(h.send("k1"), /storage down/);
	const retry = await h.send("k1");
	assert.equal(retry.ok, false);
	assert.equal(retry.status, 409);
	assert.equal(h.delivered.length, 1);
});

// -- Auto-draft guard ------------------------------------------------------

const headers = (pairs) => JSON.stringify(Object.entries(pairs).map(([key, value]) => ({ key, value })));

test("automatedMailReason flags lists, bulk, auto-replies and no-reply senders", () => {
	assert.equal(automatedMailReason(headers({ "auto-submitted": "auto-replied" }), "bob@example.org"), "Auto-Submitted: auto-replied");
	assert.equal(automatedMailReason(headers({ precedence: "bulk" }), "bob@example.org"), "Precedence: bulk");
	assert.equal(automatedMailReason(headers({ "list-id": "<news.example.org>" }), "bob@example.org"), "List-Id");
	assert.equal(automatedMailReason(headers({ "list-unsubscribe": "<https://example.org/u>" }), "bob@example.org"), "List-Unsubscribe");
	assert.equal(automatedMailReason(headers({ "x-autoreply": "yes" }), "bob@example.org"), "x-autoreply");
	assert.equal(automatedMailReason(headers({}), "no-reply@example.org"), "sender no-reply@example.org");
	assert.equal(automatedMailReason(headers({}), "MAILER-DAEMON@example.org"), "sender mailer-daemon@example.org");
	assert.equal(automatedMailReason(headers({}), "noreply+tag@example.org"), "sender noreply+tag@example.org");
});

test("automatedMailReason passes mail a person sent", () => {
	assert.equal(automatedMailReason(headers({ "auto-submitted": "no", precedence: "first-class" }), "bob@example.org"), null);
	assert.equal(automatedMailReason(headers({ subject: "Lunch?" }), "replyguy@example.org"), null);
	assert.equal(automatedMailReason(null, "bob@example.org"), null);
});
