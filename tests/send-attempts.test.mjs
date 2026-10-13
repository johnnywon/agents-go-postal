import assert from "node:assert/strict";
import { test } from "node:test";
import { openD1 } from "./helpers/d1.mjs";
import { loadTs } from "./helpers/sqlite.mjs";

// Send attempts (WON-206): pending -> sending -> sent or failed, keyed by idempotency key.

const { sendMail } = await loadTs("workers/lib/send.ts");
const { D1Mailbox } = await loadTs("workers/store/d1/mailbox.ts");

const MAILBOX = "a@example.com";

async function harness({ failDelivery = 0, failStore = 0 } = {}) {
	const d1 = await openD1();
	const box = new D1Mailbox(d1.sql, {}, MAILBOX);
	const delivered = [];
	const stored = [];
	const row = (key) => d1.exec(`SELECT state, provider_id, email_id, error FROM send_keys WHERE key = ?`, key)[0];
	const env = {
		EMAIL: {
			send: async (message) => {
				if (failDelivery > 0) { failDelivery--; throw new Error("delivery down"); }
				delivered.push(message);
				return { messageId: `provider-${delivered.length}` };
			},
		},
		BUCKET: { put: async () => {} },
	};
	const stub = Object.assign(Object.create(box), {
		getEmail: async () => null,
		markThreadRead: async () => {},
		createEmail: async (_folder, email) => {
			stored.push({ email, attempt: row(currentKey) });
			if (failStore > 0) { failStore--; throw new Error("storage down"); }
		},
	});
	for (const name of ["takeSendBudget", "refundSendBudget", "claimSendKey", "startSendKey", "recordSendProvider", "finishSendKey", "failSendKey"]) {
		stub[name] = box[name].bind(box);
	}
	let currentKey = null;
	const send = (key, fields = {}, options = {}) => {
		currentKey = key;
		return sendMail(env, MAILBOX, stub, { to: "bob@example.org", from: MAILBOX, subject: "Hi", text: "Hello", ...fields }, { kind: "new" }, { idempotencyKey: key, ...options });
	};
	return { d1, box, send, delivered, stored, row };
}

test("an attempt goes pending, sending, sent", async () => {
	const { box, row } = await harness();
	assert.deepEqual(await box.claimSendKey("k1", "h1"), { state: "new" });
	assert.equal(row("k1").state, "pending");
	assert.equal(await box.startSendKey("k1"), true);
	assert.equal(row("k1").state, "sending");
	await box.recordSendProvider("k1", "provider-9");
	await box.finishSendKey("k1", "email-1");
	assert.deepEqual(row("k1"), { state: "sent", provider_id: "provider-9", email_id: "email-1", error: null });
});

test("only one caller can start an attempt", async () => {
	const { box } = await harness();
	await box.claimSendKey("k1", "h1");
	const starts = await Promise.all([box.startSendKey("k1"), box.startSendKey("k1"), box.startSendKey("k1")]);
	assert.deepEqual(starts.filter(Boolean).length, 1);
});

test("the provider message ID is saved before the Sent copy", async () => {
	const h = await harness();
	const result = await h.send("k1");
	assert.equal(result.ok, true);
	assert.equal(h.stored.length, 1);
	assert.equal(h.stored[0].attempt.state, "sending");
	assert.equal(h.stored[0].attempt.provider_id, "provider-1");
	assert.equal(h.row("k1").state, "sent");
});

test("the same key with a different message is a conflict and sends nothing", async () => {
	const h = await harness();
	assert.equal((await h.send("k1")).ok, true);
	const reused = await h.send("k1", { subject: "Something else" });
	assert.equal(reused.ok, false);
	assert.equal(reused.status, 409);
	assert.match(reused.error, /different message/);
	assert.equal(h.delivered.length, 1);
	// The same message again is a duplicate, not a conflict.
	assert.equal((await h.send("k1")).duplicate, true);
});

test("a send left in sending returns its status instead of sending again", async () => {
	const h = await harness({ failStore: 1 });
	await assert.rejects(h.send("k1"), /storage down/);
	assert.equal(h.row("k1").state, "sending");
	const retry = await h.send("k1");
	assert.equal(retry.ok, false);
	assert.equal(retry.status, 409);
	assert.deepEqual(retry.attempt, { state: "sending", providerId: "provider-1" });
	assert.equal(h.delivered.length, 1);
});

test("a failed delivery marks the attempt failed, and a retry may change the message", async () => {
	const h = await harness({ failDelivery: 1 });
	await assert.rejects(h.send("k1"), /delivery down/);
	assert.equal(h.row("k1").state, "failed");
	assert.equal(h.row("k1").error, "delivery down");
	const retry = await h.send("k1", { subject: "Fixed" });
	assert.equal(retry.ok, true);
	assert.equal(h.delivered.length, 1);
	assert.equal(h.delivered[0].subject, "Fixed");
});

test("a deferred delivery records the provider ID when it finishes", async () => {
	const h = await harness();
	let delivery;
	const result = await h.send("k1", {}, { defer: (p) => { delivery = p; } });
	assert.equal(result.ok, true);
	await delivery;
	assert.deepEqual(h.row("k1"), { state: "sent", provider_id: "provider-1", email_id: result.id, error: null });
});
