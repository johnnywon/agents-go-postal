import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTs } from "./helpers/sqlite.mjs";

const m = await loadTs("workers/lib/agent-model.ts");

function bucket() {
	const store = new Map();
	return {
		store,
		get: async (k) => (store.has(k) ? { json: async () => JSON.parse(store.get(k)) } : null),
		put: async (k, v) => { store.set(k, v); },
	};
}

test("Workers AI is the default when nothing is stored", async () => {
	const env = { BUCKET: bucket() };
	const config = await m.readAgentModelConfig(env);
	assert.equal(config.provider, "workers-ai");
	assert.deepEqual(m.viewOf(config), { provider: "workers-ai", model: "", keySet: false, keyHint: "", defaultModel: m.WORKERS_AI_MODEL });
});

test("the view never carries the key, only its last four characters", () => {
	const view = m.viewOf({ provider: "openrouter", model: "a/b", apiKey: "sk-or-v1-0123456789abcd" });
	assert.equal(view.keySet, true);
	assert.equal(view.keyHint, "abcd");
	assert.ok(!JSON.stringify(view).includes("sk-or"));
});

test("an update keeps the stored key unless a new one or an empty string is sent", () => {
	const current = { provider: "openrouter", model: "a/b", apiKey: "sk-or-old-key-1234" };
	assert.equal(m.mergeAgentModelConfig(current, { model: "c/d" }).apiKey, "sk-or-old-key-1234");
	assert.equal(m.mergeAgentModelConfig(current, { apiKey: " sk-or-new-key-5678 " }).apiKey, "sk-or-new-key-5678");
	assert.deepEqual(m.mergeAgentModelConfig(current, { apiKey: "" }), { error: "Add an OpenRouter API key." });
	assert.equal(m.mergeAgentModelConfig(current, { provider: "workers-ai", apiKey: "" }).apiKey, undefined);
});

test("OpenRouter needs both a key and a model", () => {
	const none = { provider: "workers-ai" };
	assert.deepEqual(m.mergeAgentModelConfig(none, { provider: "openrouter", model: "a/b" }), { error: "Add an OpenRouter API key." });
	assert.deepEqual(m.mergeAgentModelConfig(none, { provider: "openrouter", apiKey: "sk-or-x-12345678" }), { error: "Choose an OpenRouter model." });
	assert.equal(m.mergeAgentModelConfig(none, { provider: "openrouter", apiKey: "sk-or-x-12345678", model: "a/b" }).provider, "openrouter");
});

test("config round-trips through R2", async () => {
	const env = { BUCKET: bucket() };
	await m.writeAgentModelConfig(env, { provider: "openrouter", model: "a/b", apiKey: "k" });
	assert.ok(env.BUCKET.store.has("config/agent-model.json"));
	assert.deepEqual(await m.readAgentModelConfig(env), { provider: "openrouter", model: "a/b", apiKey: "k" });
});
