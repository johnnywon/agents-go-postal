import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTs } from "./helpers/sqlite.mjs";

const { resolveMailbox, sharedAgentNote } = await loadTs("shared/agent.ts");
const known = ["a@example.com", "b@example.net"];

test("a tool call acts on the address it names, else the agent's own", () => {
	assert.deepEqual(resolveMailbox("B@Example.net", null, known), { mailboxId: "b@example.net" });
	assert.deepEqual(resolveMailbox(undefined, "a@example.com", known), { mailboxId: "a@example.com" });
	assert.match(resolveMailbox(undefined, null, known).error, /which address/);
	assert.match(resolveMailbox("c@example.org", null, known).error, /Unknown address c@example.org/);
});

test("the shared agent is told every address and the open email", () => {
	assert.match(sharedAgentNote(known, undefined), /a@example.com, b@example.net/);
	assert.doesNotMatch(sharedAgentNote(known, { open: null }), /reading/);
	assert.match(sharedAgentNote(known, { open: { mailboxId: "b@example.net", emailId: "e1" } }), /reading email e1 in b@example.net/);
});
