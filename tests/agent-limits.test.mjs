import assert from "node:assert/strict";
import { test } from "node:test";
import { openD1 } from "./helpers/d1.mjs";
import { loadTs } from "./helpers/sqlite.mjs";

// Send limits (WON-207): agents and MCP have their own daily and recipient caps, and the check is atomic.

const { sendMail } = await loadTs("workers/lib/send.ts");
const { D1Mailbox } = await loadTs("workers/store/d1/mailbox.ts");
const { SEND_LIMITS, countRecipients, recipientLimitError } = await loadTs("workers/lib/send-budget.ts");

const MAILBOX = "a@example.com";

async function harness({ failDelivery = 0 } = {}) {
	const d1 = await openD1();
	const box = new D1Mailbox(d1.sql, {}, MAILBOX);
	const delivered = [];
	const env = {
		EMAIL: {
			send: async (message) => {
				if (failDelivery > 0) { failDelivery--; throw new Error("delivery down"); }
				delivered.push(message);
				return { messageId: `p${delivered.length}` };
			},
		},
		BUCKET: { put: async () => {} },
	};
	const stub = { getEmail: async () => null, markThreadRead: async () => {}, createEmail: async () => {} };
	for (const name of ["takeSendBudget", "refundSendBudget", "claimSendKey", "startSendKey", "recordSendProvider", "finishSendKey", "failSendKey"]) {
		stub[name] = box[name].bind(box);
	}
	const send = (actor, fields = {}) =>
		sendMail(env, MAILBOX, stub, { to: "bob@example.org", from: MAILBOX, subject: "Hi", text: "Hello", ...fields }, { kind: "new" }, { actor });
	const budgetRows = () => d1.exec(`SELECT actor FROM send_budget`).map((r) => r.actor);
	return { d1, box, send, delivered, budgetRows };
}

test("agents and MCP share a daily cap; people keep sending", async () => {
	const h = await harness();
	// Spread over the day, so the hourly limit stays out of it.
	const earlier = new Date(Date.now() - 3 * 3_600_000).toISOString();
	for (let i = 0; i < SEND_LIMITS.agentDay - 1; i++) {
		h.d1.exec(`INSERT INTO send_budget (mailbox_id, actor, recipients, at) VALUES (?, ?, 1, ?)`, MAILBOX, i % 2 ? "agent" : "mcp", earlier);
	}
	assert.equal((await h.send("mcp")).ok, true);
	const refused = await h.send("agent");
	assert.equal(refused.status, 429);
	assert.match(refused.error, /agents and MCP/);
	assert.equal((await h.send("mcp")).status, 429);
	assert.equal((await h.send("person")).ok, true);
});

test("the hourly limit covers everyone", async () => {
	const h = await harness();
	for (let i = 0; i < SEND_LIMITS.hour; i++) assert.equal((await h.send("person")).ok, true);
	const refused = await h.send("person");
	assert.equal(refused.status, 429);
	assert.match(refused.error, /per hour/);
	assert.match((await h.send("agent")).error, /per hour/);
});

test("the daily limit counts the last 24 hours only", async () => {
	const h = await harness();
	const old = new Date(Date.now() - 25 * 3_600_000).toISOString();
	const recent = new Date(Date.now() - 2 * 3_600_000).toISOString();
	for (let i = 0; i < SEND_LIMITS.day + 9; i++) {
		h.d1.exec(`INSERT INTO send_budget (mailbox_id, actor, recipients, at) VALUES (?, 'person', 1, ?)`, MAILBOX, i < 10 ? old : recent);
	}
	assert.equal((await h.send("person")).ok, true);
	assert.match((await h.send("person")).error, /per day/);
});

test("the check and the count are one statement, so a burst can't overshoot", async () => {
	const h = await harness();
	const results = await Promise.all(Array.from({ length: SEND_LIMITS.agentDay + 5 }, () => h.box.takeSendBudget("agent", 1)));
	assert.equal(results.filter((r) => r.ok).length, SEND_LIMITS.agentDay);
	assert.equal(h.budgetRows().length, SEND_LIMITS.agentDay);
});

test("recipients per message are capped lower for agents", async () => {
	const h = await harness();
	const many = (n) => Array.from({ length: n }, (_, i) => `r${i}@example.org`);
	const agent = await h.send("agent", { to: many(SEND_LIMITS.recipients.agent - 1), cc: ["c@example.org", "d@example.org"] });
	assert.equal(agent.status, 400);
	assert.match(agent.error, /agents and MCP/);
	assert.equal((await h.send("person", { to: many(SEND_LIMITS.recipients.agent + 1) })).ok, true);
	assert.equal((await h.send("person", { to: many(SEND_LIMITS.recipients.person + 1) })).status, 400);
	assert.equal(h.delivered.length, 1);
	assert.equal(countRecipients("a@example.org, b@example.org", ["c@example.org"], undefined), 3);
	assert.equal(recipientLimitError("mcp", SEND_LIMITS.recipients.agent), null);
});

test("a send that never delivered gives its slot back", async () => {
	const h = await harness({ failDelivery: 1 });
	await assert.rejects(h.send("agent"), /delivery down/);
	assert.deepEqual(h.budgetRows(), []);
	assert.equal((await h.send("agent")).ok, true);
	assert.deepEqual(h.budgetRows(), ["agent"]);
});
