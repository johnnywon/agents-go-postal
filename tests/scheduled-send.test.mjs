import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTs, openDb } from "./helpers/sqlite.mjs";

const { app } = await loadTs("workers/index.ts");
const sched = await loadTs("workers/lib/scheduled-send.ts");
const { mailboxMigrations } = await loadTs("workers/durableObject/migrations.ts");

const MAILBOX = "a@example.com";
const NOW = Date.parse("2026-10-11T12:00:00Z");

// -- Route validation -------------------------------------------------

function routeEnv(calls) {
	const stub = {
		scheduleSend: async (input) => (calls.push(input), { id: "draft-new", sendAt: new Date(input.sendAt).toISOString() }),
		cancelScheduled: async (id) => id === "known",
	};
	return {
		EMAIL_ADDRESSES: [MAILBOX],
		BUCKET: { head: async () => ({}) },
		MAILBOX: { idFromName: (name) => name, get: () => stub },
	};
}

async function schedule(body, calls = []) {
	const response = await app.request(`http://localhost/api/v1/mailboxes/${MAILBOX}/scheduled`, {
		method: "POST",
		headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
		body: typeof body === "string" ? body : JSON.stringify(body),
	}, routeEnv(calls));
	return { status: response.status, json: await response.json() };
}

const email = (fields = {}) => ({ to: "bob@example.org", from: MAILBOX, subject: "Hi", text: "Hello", ...fields });
const inMinutes = (m) => new Date(Date.now() + m * 60_000).toISOString();

test("scheduling refuses a time in the past or under 30 seconds out", async () => {
	const calls = [];
	for (const sendAt of [new Date(Date.now() - 60_000).toISOString(), new Date(Date.now() + 5_000).toISOString()]) {
		const { status, json } = await schedule({ sendAt, mode: "new", email: email() }, calls);
		assert.equal(status, 400);
		assert.match(json.error, /30 seconds/);
	}
	const tooFar = await schedule({ sendAt: new Date(Date.now() + 400 * 86_400_000).toISOString(), mode: "new", email: email() }, calls);
	assert.equal(tooFar.status, 400);
	assert.match(tooFar.json.error, /366 days/);
	assert.equal(calls.length, 0);
});

test("scheduling validates the sender, the mode and the payload size", async () => {
	const calls = [];
	const wrongSender = await schedule({ sendAt: inMinutes(10), mode: "new", email: email({ from: "c@example.net" }) }, calls);
	assert.equal(wrongSender.status, 400);
	assert.match(wrongSender.json.error, /From address/);

	const noOriginal = await schedule({ sendAt: inMinutes(10), mode: "reply", email: email() }, calls);
	assert.equal(noOriginal.status, 400);
	assert.match(noOriginal.json.error, /original_id/);

	const big = await schedule({ sendAt: inMinutes(10), mode: "new", email: email({ text: "x".repeat(1_600_000) }) }, calls);
	assert.equal(big.status, 413);
	assert.equal(calls.length, 0);
});

test("a valid schedule reaches the mailbox and answers 201", async () => {
	const calls = [];
	const sendAt = inMinutes(60);
	const { status, json } = await schedule({ sendAt, draft_id: "d1", mode: "reply-all", original_id: "o1", email: email() }, calls);
	assert.equal(status, 201);
	assert.deepEqual(json, { id: "draft-new", sendAt });
	assert.equal(calls[0].draftId, "d1");
	assert.equal(calls[0].mode, "reply-all");
	assert.equal(calls[0].originalId, "o1");
});

test("cancel answers cancelled or 404", async () => {
	const cancel = (id) => app.request(`http://localhost/api/v1/mailboxes/${MAILBOX}/scheduled/${id}`, {
		method: "DELETE", headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
	}, routeEnv([]));
	const known = await cancel("known");
	assert.equal(known.status, 200);
	assert.deepEqual(await known.json(), { status: "cancelled" });
	assert.equal((await cancel("missing")).status, 404);
});

// -- Alarm run ------------------------------------------------------

function mailbox() {
	const handle = openDb();
	handle.exec(mailboxMigrations.find((m) => m.name === "10_scheduled_send").sql);
	return handle;
}

const payload = (subject) => ({ mode: "new", email: email({ subject }) });

function deps(exec, { drafts, send }) {
	const deleted = [];
	return {
		deleted,
		deps: {
			exec,
			now: () => NOW,
			draftFolder: async (id) => (drafts.has(id) ? "draft" : null),
			deleteDraft: async (id) => (deleted.push(id), drafts.delete(id)),
			send,
		},
	};
}

test("due rows are sent and their drafts deleted; later rows wait", async () => {
	const { exec } = mailbox();
	sched.insertScheduled(exec, "due", new Date(NOW - 1_000).toISOString(), payload("due"));
	sched.insertScheduled(exec, "later", new Date(NOW + 3_600_000).toISOString(), payload("later"));
	const sent = [];
	const { deps: d, deleted } = deps(exec, { drafts: new Set(["due", "later"]), send: async (p) => (sent.push(p.email.subject), null) });

	const result = await sched.runDueScheduled(d, "draft");
	assert.deepEqual(result.sent, ["due"]);
	assert.deepEqual(sent, ["due"]);
	assert.deepEqual(deleted, ["due"]);
	assert.deepEqual(sched.listScheduledRows(exec).map((r) => r.emailId), ["later"]);
	assert.equal(sched.nextScheduledAt(exec), NOW + 3_600_000);
});

test("a deleted or edited draft drops its schedule without sending", async () => {
	const { exec } = mailbox();
	sched.insertScheduled(exec, "gone", new Date(NOW - 1_000).toISOString(), payload("gone"));
	let sends = 0;
	const { deps: d } = deps(exec, { drafts: new Set(), send: async () => (sends++, null) });
	const result = await sched.runDueScheduled(d, "draft");
	assert.deepEqual(result.dropped, ["gone"]);
	assert.equal(sends, 0);
	assert.deepEqual(sched.listScheduledRows(exec), []);
});

test("a failing send retries in 15 minutes, three attempts, then keeps its error", async () => {
	const { exec } = mailbox();
	sched.insertScheduled(exec, "bad", new Date(NOW - 1_000).toISOString(), payload("bad"));
	const drafts = new Set(["bad"]);
	let clock = NOW;
	const run = (send) => sched.runDueScheduled({ ...deps(exec, { drafts, send }).deps, now: () => clock }, "draft");

	await run(async () => { throw new Error("binding down"); });
	let [row] = sched.listScheduledRows(exec);
	assert.equal(row.attempts, 1);
	assert.equal(row.error, "binding down");
	assert.equal(Date.parse(row.sendAt), NOW + 15 * 60_000);

	assert.deepEqual((await run(async () => null)).sent, [], "not due again until the retry time");

	clock = NOW + 15 * 60_000;
	await run(async () => "Rate limit exceeded");
	clock += 15 * 60_000;
	await run(async () => "Rate limit exceeded");
	[row] = sched.listScheduledRows(exec);
	assert.equal(row.attempts, 3);
	assert.equal(row.error, "Rate limit exceeded");
	assert.equal(sched.nextScheduledAt(exec), null, "no more retries");

	clock += 60 * 60_000;
	assert.deepEqual((await run(async () => null)).sent, []);
	assert.ok(drafts.has("bad"), "the draft stays");
});

test("stored modes map to the send path", () => {
	assert.deepEqual(sched.sendModeOf({ mode: "new" }), { kind: "new" });
	assert.deepEqual(sched.sendModeOf({ mode: "reply-all", original_id: "o" }), { kind: "reply", originalId: "o" });
	assert.deepEqual(sched.sendModeOf({ mode: "reply", original_id: "o" }), { kind: "reply", originalId: "o" });
	assert.deepEqual(sched.sendModeOf({ mode: "forward", original_id: "o" }), { kind: "forward", originalId: "o" });
});

test("the scheduled list spans configured mailboxes, soonest first", async () => {
	const rows = {
		"a@example.com": [{ emailId: "a1", sendAt: "2026-10-12T09:00:00.000Z", attempts: 0, error: null }],
		"b@example.com": [{ emailId: "b1", sendAt: "2026-10-11T09:00:00.000Z", attempts: 3, error: "Rate limit exceeded" }],
		"c@example.com": [{ emailId: "c1", sendAt: "2026-10-10T09:00:00.000Z", attempts: 0, error: null }],
	};
	const env = {
		EMAIL_ADDRESSES: ["a@example.com", "b@example.com"],
		BUCKET: { list: async () => ({ objects: Object.keys(rows).map((id) => ({ key: `mailboxes/${id}.json` })) }) },
		MAILBOX: { idFromName: (name) => name, get: (name) => ({ listScheduled: async () => rows[name] }) },
	};
	const response = await app.request("http://localhost/api/v1/mail/scheduled", {}, env);
	assert.deepEqual(await response.json(), [
		{ mailboxId: "b@example.com", emailId: "b1", sendAt: "2026-10-11T09:00:00.000Z", error: "Rate limit exceeded" },
		{ mailboxId: "a@example.com", emailId: "a1", sendAt: "2026-10-12T09:00:00.000Z", error: null },
	]);
});
