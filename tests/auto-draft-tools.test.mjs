import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTs } from "./helpers/sqlite.mjs";

const { AUTO_DRAFT_TOOLS, autoDraftRecipient, createAutoDraftTools } = await loadTs("workers/agent/auto-draft.ts");

const MAILBOX = "a@example.com";
const TARGET = { mailboxId: MAILBOX, emailId: "e2", threadId: "t1", to: "ann@example.net" };

function fakeImpl() {
	const calls = [];
	return {
		calls,
		getEmail: async (_env, mailboxId, id) => (calls.push(["getEmail", mailboxId, id]), { id }),
		getThread: async (_env, mailboxId, threadId) => (calls.push(["getThread", mailboxId, threadId]), { thread_id: threadId, messages: [{ id: "e1" }, { id: "e2" }] }),
		draftReply: async (_env, mailboxId, params) => (calls.push(["draftReply", mailboxId, params]), { status: "draft_saved", draftId: "d1" }),
	};
}

test("auto-draft gets only get_email, get_thread and draft_reply", () => {
	const tools = createAutoDraftTools({}, TARGET, fakeImpl());
	assert.deepEqual(Object.keys(tools).sort(), ["draft_reply", "get_email", "get_thread"]);
	assert.deepEqual([...AUTO_DRAFT_TOOLS].sort(), Object.keys(tools).sort());
	for (const name of ["draft_email", "send_draft", "delete_label", "rename_label", "set_shortcut", "reset_shortcuts", "move_email", "discard_draft", "label_conversation", "search_emails", "search_all_mail"]) {
		assert.equal(tools[name], undefined, `${name} must not reach auto-draft`);
	}
});

test("draft_reply takes no recipient or email id from the model", async () => {
	const impl = fakeImpl();
	const { draft_reply } = createAutoDraftTools({}, TARGET, impl);
	assert.deepEqual(Object.keys(draft_reply.inputSchema.shape).sort(), ["body", "subject"]);
	// Extra fields the model sends are ignored.
	const input = draft_reply.inputSchema.parse({ to: "other@example.org", originalEmailId: "e9", subject: "Re: Hi", body: "Thanks" });
	await draft_reply.execute(input);
	const [, mailboxId, params] = impl.calls.find(([op]) => op === "draftReply");
	assert.equal(mailboxId, MAILBOX);
	assert.equal(params.to, "ann@example.net");
	assert.equal(params.originalEmailId, "e2");
	assert.equal(params.subject, "Re: Hi");
});

test("get_thread reads the new email's thread and get_email stays inside it", async () => {
	const impl = fakeImpl();
	const { get_email, get_thread } = createAutoDraftTools({}, TARGET, impl);
	assert.deepEqual(Object.keys(get_thread.inputSchema.shape), []);
	assert.equal((await get_thread.execute({ threadId: "t9" })).thread_id, "t1");
	assert.deepEqual(await get_email.execute({ emailId: "e1" }), { id: "e1" });
	assert.deepEqual(await get_email.execute({ emailId: "e2" }), { id: "e2" });
	assert.match((await get_email.execute({ emailId: "e7" })).error, /not found/);
	assert.ok(!impl.calls.some(([op, , id]) => op === "getEmail" && id === "e7"));
});

test("the reply goes to Reply-To, else the sender", () => {
	assert.equal(autoDraftRecipient({ sender: "ann@example.net", raw_headers: null }), "ann@example.net");
	assert.equal(autoDraftRecipient({ sender: "Ann@Example.net", raw_headers: JSON.stringify([{ key: "from", value: "Ann <ann@example.net>" }]) }), "ann@example.net");
	assert.equal(
		autoDraftRecipient({ sender: "ann@example.net", raw_headers: JSON.stringify([{ key: "reply-to", value: "Support <Help@example.org>, team@example.org" }]) }),
		"help@example.org, team@example.org",
	);
	assert.equal(autoDraftRecipient({ sender: "", raw_headers: null }), "");
});
