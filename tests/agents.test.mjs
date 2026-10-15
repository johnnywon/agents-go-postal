import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { openD1 } from "./helpers/d1.mjs";
import { openSql } from "./helpers/sql.mjs";
import { loadTs } from "./helpers/sqlite.mjs";

// Agents (0.9): one job on the addresses it watches, Watch, Draft or Send.

const agents = await loadTs("workers/lib/agents.ts");
const runs = await loadTs("workers/agent/runs.ts");
const { app } = await loadTs("workers/index.ts");

const A = "a@example.com";
const B = "b@example.org";
const mail = (fields = {}) => ({ mailboxId: A, from: "bob@example.net", subject: "Guest post opportunity", body: "Can I write for your blog?", ...fields });

test("an agent starts in Watch at the bottom of the list, and names are unique", async () => {
	const { sql } = await openD1();
	const first = await agents.createAgent(sql, { name: "Outreach", job: "Decline guest-post pitches." });
	const second = await agents.createAgent(sql, { name: "Intake", job: "Ask for the order number.", mode: "draft", addresses: [B] });
	assert.equal(first.agent.mode, "watch");
	assert.equal(first.agent.position, 0);
	assert.equal(second.agent.position, 1);
	assert.deepEqual(second.agent.addresses, [B]);
	assert.deepEqual(await agents.createAgent(sql, { name: "outreach", job: "x" }), { error: "An agent with that name exists" });
	await agents.orderAgents(sql, [second.agent.id, first.agent.id]);
	assert.deepEqual((await agents.listAgents(sql)).map((a) => a.name), ["Intake", "Outreach"]);
	const updated = await agents.updateAgent(sql, first.agent.id, { mode: "draft", rules: [{ field: "subject", op: "contains", value: "guest post" }] });
	assert.equal(updated.agent.mode, "draft");
	assert.equal(updated.agent.job, "Decline guest-post pitches.");
	assert.deepEqual(updated.agent.rules, [{ field: "subject", op: "contains", value: "guest post" }]);
	assert.equal(await agents.deleteAgent(sql, first.agent.id), true);
	assert.equal(await agents.deleteAgent(sql, first.agent.id), false);
});

test("rules narrow the mail down before the model sees it", () => {
	const make = (fields) => ({ id: fields.name, enabled: true, addresses: [], rules: [], ...fields });
	const list = [
		make({ name: "all" }),
		make({ name: "only b", addresses: [B] }),
		make({ name: "guest", rules: [{ field: "subject", op: "contains", value: "guest post, link exchange" }] }),
		make({ name: "not guest", rules: [{ field: "subject", op: "not_contains", value: "guest" }] }),
		make({ name: "net domain", rules: [{ field: "from", op: "domain", value: "@example.net" }] }),
		make({ name: "off", enabled: false }),
	];
	assert.deepEqual(agents.matchAgents(list, mail()).map((a) => a.name), ["all", "guest", "net domain"]);
	assert.deepEqual(agents.matchAgents(list, mail({ mailboxId: B, subject: "Link exchange?", from: "x@example.com" })).map((a) => a.name), ["all", "only b", "guest", "not guest"]);
	assert.deepEqual(agents.matchAgents(list, mail({ subject: "Invoice", from: "c@example.com" })).map((a) => a.name), ["all", "not guest"]);
});

test("migration 0008 adds agents, the run's agent and the draft's agent on top of 0007", async () => {
	const { sql } = openSql();
	const before = readdirSync("migrations").filter((f) => /^\d{4}_.*\.sql$/.test(f) && f < "0008").sort();
	await sql.schema(before.map((f) => readFileSync(`migrations/${f}`, "utf8")).join("\n"));
	await sql.schema(readFileSync("migrations/0008_agents.sql", "utf8"));
	assert.deepEqual(await agents.listAgents(sql), []);
	const columns = async (table) => (await sql.all(`SELECT name FROM pragma_table_info('${table}')`)).map((r) => r.name);
	assert.ok((await columns("auto_draft_runs")).includes("agent_id"));
	assert.ok((await columns("draft_notes")).includes("agent"));
});

test("Send waits for 0.9: the API refuses it and a stored Send agent works as Draft", async () => {
	assert.equal(agents.SEND_ENABLED, false);
	const refused = agents.AgentBody.partial().safeParse({ mode: "send" });
	assert.equal(refused.success, false);
	assert.equal(refused.error.issues[0].message, agents.SEND_LATER);
	assert.equal(agents.AgentBody.partial().safeParse({ mode: "draft" }).success, true);
	const { sql } = await openD1();
	const made = await agents.createAgent(sql, { name: "Old sender", job: "Decline pitches." });
	await sql.run(`UPDATE agents SET mode = 'send' WHERE id = ?`, made.agent.id);
	assert.equal((await agents.getAgent(sql, made.agent.id)).mode, "draft");
});

test("a run records which agent took it, and ends watched or sent", async () => {
	const { sql } = await openD1();
	const target = (emailId) => ({ mailboxId: A, emailId, threadId: emailId, sender: "bob@example.net" });
	const discard = async () => {};
	await runs.recordRun(sql, target("w"));
	await runs.attemptRun(sql, { emailId: "w" }, async () => ({ status: "watched", agentId: "ag1", reason: "Would reply: no thanks" }), { final: false, discardDraft: discard });
	await runs.recordRun(sql, target("s"));
	await runs.attemptRun(sql, { emailId: "s" }, async () => ({ status: "sent", draftId: null, agentId: "ag1" }), { final: false, discardDraft: discard });
	await runs.recordRun(sql, target("d"));
	await runs.attemptRun(sql, { emailId: "d" }, async () => ({ status: "drafted", draftId: "d1", agentId: "ag2", reason: "daily limit of 0 reached; kept as a draft" }), { final: false, discardDraft: discard });
	const byAgent = await runs.listRuns(sql, { agentId: "ag1" });
	assert.deepEqual(byAgent.map((r) => [r.emailId, r.state]).sort(), [["s", "sent"], ["w", "watched"]]);
	assert.deepEqual(await agents.agentSendsToday(sql, "ag1", "bob@example.net"), { total: 1, toSender: 1 });
	const stats = await agents.agentStats(sql);
	assert.deepEqual(stats.find((s) => s.agentId === "ag1").runs, { sent: 1, watched: 1 });
	assert.equal(stats.find((s) => s.agentId === "ag2").today, 1);
});

test("agent routes", async () => {
	const d1 = await openD1();
	await d1.addMailboxes(A, B);
	const env = { DB: d1.DB, EMAIL_ADDRESSES: [A, B] };
	const call = (path, method = "GET", body) => app.request(`/api/v1/agents${path}`, {
		method, headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" }, body: body ? JSON.stringify(body) : undefined,
	}, env);
	const created = await call("", "POST", { name: "Outreach", job: "Decline guest-post pitches." });
	assert.equal(created.status, 201);
	const { id, mode } = await created.json();
	assert.equal(mode, "watch");
	assert.equal((await call("", "POST", { name: " ", job: "x" })).status, 400);
	assert.equal((await call("", "POST", { name: "Bad", job: "x", mode: "shout" })).status, 400);
	assert.equal((await call(`/${id}`, "PUT", { mode: "draft" })).status, 200);
	const list = await (await call("")).json();
	assert.deepEqual(list.agents.map((a) => [a.name, a.mode]), [["Outreach", "draft"]]);
	assert.deepEqual(list.stats, []);
	assert.equal((await call("/order", "PUT", { ids: [id] })).status, 200);
	assert.deepEqual(await (await call(`/${id}/runs`)).json(), []);
	assert.deepEqual(await (await call("/review")).json(), []);
	assert.equal((await call("/nope", "PUT", { name: "X" })).status, 404);
	assert.equal((await call(`/${id}`, "DELETE")).status, 200);
	assert.equal((await call(`/${id}`, "DELETE")).status, 404);
});

test("review lists agent drafts still waiting in Drafts", async () => {
	const d1 = await openD1();
	await d1.addMailboxes(A);
	const { D1Mailbox } = await loadTs("workers/store/d1/mailbox.ts");
	const box = new D1Mailbox(d1.sql, { delete: async () => {}, put: async () => {} }, A);
	await box.createEmail("draft", { id: "dr1", subject: "Re: Guest post", sender: A, recipient: "bob@example.net", date: "2026-10-01T10:00:00.000Z", body: "<p>No thanks</p>", thread_id: "t1" }, []);
	await box.setDraftNotes("dr1", { origin: "auto-draft", agent: "Outreach", instructions: [] });
	await box.createEmail("draft", { id: "mine", subject: "Hi", sender: A, recipient: "c@example.com", date: "2026-10-01T11:00:00.000Z", body: "<p>Mine</p>", thread_id: "t2" }, []);
	const list = await agents.listAgentDrafts(d1.sql, [A]);
	assert.deepEqual(list.map((d) => [d.emailId, d.agent]), [["dr1", "Outreach"]]);
});

test("the drafting prompt lists the matched agents' jobs, and the model's pick is found by name", () => {
	const list = [
		{ name: "Penny", job: "Decline pitches.", instructions: "One line.", exampleReply: "" },
		{ name: "Otis", job: "Ask for the order number.", instructions: "", exampleReply: "Could you send it?" },
	];
	const prompt = agents.agentPrompt(list);
	assert.match(prompt, /### Penny\nJob: Decline pitches\.\nInstructions: One line\./);
	assert.match(prompt, /### Otis\nJob: Ask for the order number\.\nExample reply:\nCould you send it\?/);
	assert.equal(agents.agentPrompt([]), "");
	assert.equal(agents.findAgent(list, " penny ")?.name, "Penny");
	assert.equal(agents.findAgent(list, "Mabel"), null);
	assert.equal(agents.findAgent(list, undefined), null);
});
