import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as esbuild from "esbuild";

// Agent.tsx imports React and the agent client; only the two pure helpers are tested.
const source = readFileSync("app/components/postal/Agent.tsx", "utf8");
const pick = (name) => source.slice(source.indexOf(`export function ${name}`)).match(/^export function[\s\S]*?\n}\n/)[0];
const { code } = await esbuild.transform(`${pick("sentHistory")}\n${pick("stepHistory")}`, { loader: "ts", format: "esm" });
const { sentHistory, stepHistory } = await import(`data:text/javascript,${encodeURIComponent(code)}`);

const user = (text) => ({ role: "user", parts: [{ type: "text", text }] });
const bot = (text) => ({ role: "assistant", parts: [{ type: "text", text }] });

test("history keeps what you sent, oldest first, without repeats or auto-triggered entries", () => {
	const messages = [user("label receipts"), bot("ok"), user("label receipts"), user("[Auto-triggered] New email"), user("  "), user("summarize unread")];
	assert.deepEqual(sentHistory(messages), ["label receipts", "summarize unread"]);
});

test("Up walks back to the oldest and stops; Down walks forward to the line you were typing", () => {
	assert.equal(stepHistory(3, null, -1), 2);
	assert.equal(stepHistory(3, 2, -1), 1);
	assert.equal(stepHistory(3, 0, -1), 0);
	assert.equal(stepHistory(3, 0, 1), 1);
	assert.equal(stepHistory(3, 2, 1), null);
	assert.equal(stepHistory(3, null, 1), null);
});
