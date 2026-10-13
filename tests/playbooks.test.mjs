import assert from "node:assert/strict";
import { test } from "node:test";
import { openD1 } from "./helpers/d1.mjs";
import { loadTs } from "./helpers/sqlite.mjs";

// Drafting playbooks per address (WON-225).

const playbooks = await loadTs("workers/lib/playbooks.ts");
const { autoDraftPrompt, createAutoDraftTools } = await loadTs("workers/agent/auto-draft.ts");
const { app } = await loadTs("workers/index.ts");

const A = "a@example.com";
const B = "b@example.org";

async function setup() {
	const d1 = await openD1();
	await d1.addMailboxes(A, B);
	return d1;
}

test("playbooks are kept per address, in order", async () => {
	const { sql } = await setup();
	const first = await playbooks.createPlaybook(sql, A, { name: "Meetings", whenToUse: "Meeting requests", instructions: "Offer two times." });
	const second = await playbooks.createPlaybook(sql, A, { name: "Pricing", instructions: "Link the pricing page." });
	assert.equal(first.playbook.position, 0);
	assert.equal(second.playbook.position, 1);
	await playbooks.createPlaybook(sql, B, { name: "Meetings" });
	assert.deepEqual((await playbooks.listPlaybooks(sql, A)).map((p) => p.name), ["Meetings", "Pricing"]);
	assert.deepEqual((await playbooks.listPlaybooks(sql, B)).map((p) => p.name), ["Meetings"]);
	assert.deepEqual(await playbooks.createPlaybook(sql, A, { name: "Meetings" }), { error: "A playbook with that name exists" });

	const updated = await playbooks.updatePlaybook(sql, A, second.playbook.id, { position: 0, exampleReply: "See example.com/pricing" });
	assert.equal(updated.playbook.exampleReply, "See example.com/pricing");
	assert.equal(updated.playbook.instructions, "Link the pricing page.");
	assert.deepEqual(await playbooks.updatePlaybook(sql, B, second.playbook.id, { name: "X" }), { playbook: null });
	assert.equal(await playbooks.deletePlaybook(sql, B, first.playbook.id), false);
	assert.equal(await playbooks.deletePlaybook(sql, A, first.playbook.id), true);
	assert.deepEqual((await playbooks.listPlaybooks(sql, A)).map((p) => p.name), ["Pricing"]);
});

test("an address has at most MAX_PLAYBOOKS", async () => {
	const { sql } = await setup();
	for (let i = 0; i < playbooks.MAX_PLAYBOOKS; i++) assert.ok("playbook" in await playbooks.createPlaybook(sql, A, { name: `P${i}` }));
	assert.match((await playbooks.createPlaybook(sql, A, { name: "One more" })).error, /up to/);
});

test("the auto-draft prompt lists the playbooks and draft_reply records the one used", async () => {
	const list = [
		{ id: "1", name: "Meetings", whenToUse: "Meeting requests", instructions: "Offer two times.", exampleReply: "Tuesday or Thursday?", position: 0 },
		{ id: "2", name: "Pricing", whenToUse: "", instructions: "Link the pricing page.", exampleReply: "", position: 1 },
	];
	const email = { id: "e1", date: "2026-10-01T00:00:00Z", folder_id: "inbox", sender: "bob@example.org", sender_name: "Bob", recipient: A, subject: "Meet?", body_text: "Can we meet?" };
	const prompt = autoDraftPrompt(A, "t1", { email, thread: [email], replyTo: "bob@example.org" }, list);
	assert.match(prompt, /## Playbooks/);
	assert.match(prompt, /### Meetings\nWhen to use: Meeting requests\nInstructions: Offer two times.\nExample reply:\nTuesday or Thursday\?/);
	assert.doesNotMatch(autoDraftPrompt(A, "t1", { email, thread: [email], replyTo: "bob@example.org" }), /Playbooks/);

	const calls = [];
	const drafted = [];
	const fakeDraft = async (_env, _mailbox, params) => { calls.push(params); return { status: "draft_saved", draftId: "d1", message: "", draft: {} }; };
	const tools = createAutoDraftTools({}, { mailboxId: A, emailId: "e1", threadId: "t1", to: "bob@example.org" }, { thread: [email] }, fakeDraft, { playbooks: list, onDraft: (id) => drafted.push(id) });
	await tools.draft_reply.execute({ subject: "Re: Meet?", body: "Tuesday?", playbook: "meetings" });
	await tools.draft_reply.execute({ subject: "Re: Meet?", body: "Sure", playbook: "Made up" });
	await tools.draft_reply.execute({ subject: "Re: Meet?", body: "Sure" });
	assert.deepEqual(calls.map((c) => c.notes), [
		{ origin: "auto-draft", playbook: "Meetings", instructions: [] },
		{ origin: "auto-draft", playbook: null, instructions: [] },
		{ origin: "auto-draft", playbook: null, instructions: [] },
	]);
	assert.deepEqual(drafted, ["d1", "d1", "d1"]);
	// Without playbooks the tool has no playbook argument.
	const plain = createAutoDraftTools({}, { mailboxId: A, emailId: "e1", threadId: "t1", to: "bob@example.org" }, { thread: [email] }, fakeDraft);
	assert.equal("playbook" in plain.draft_reply.inputSchema.shape, false);
});

test("playbook routes", async () => {
	const d1 = await setup();
	const env = { DB: d1.DB, EMAIL_ADDRESSES: [A, B] };
	const call = (path, method = "GET", body) => app.request(`/api/v1/mailboxes/${A}/playbooks${path}`, {
		method, headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" }, body: body ? JSON.stringify(body) : undefined,
	}, env);
	const created = await call("", "POST", { name: "Meetings", whenToUse: "Meeting requests" });
	assert.equal(created.status, 201);
	const { id } = await created.json();
	assert.equal((await call("", "POST", { name: "  " })).status, 400);
	assert.equal((await call(`/${id}`, "PUT", { instructions: "Offer two times." })).status, 200);
	assert.deepEqual((await (await call("")).json()).map((p) => [p.name, p.instructions]), [["Meetings", "Offer two times."]]);
	assert.equal((await call("/nope", "PUT", { name: "X" })).status, 404);
	assert.equal((await call(`/${id}`, "DELETE")).status, 200);
	assert.equal((await call(`/${id}`, "DELETE")).status, 404);
});
