import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTs } from "./helpers/sqlite.mjs";

const m = await loadTs("workers/lib/agent-model.ts");
const w = await loadTs("shared/workers-ai-models.ts");

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
	assert.deepEqual(m.viewOf(config), { provider: "workers-ai", model: "", keySet: false, keyHint: "", workersAiModel: "", defaultModel: m.WORKERS_AI_MODEL });
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

test("the default Workers AI model is the recommended one in the suggested list", () => {
	assert.equal(m.WORKERS_AI_MODEL, w.RECOMMENDED_WORKERS_AI_MODEL);
	assert.equal(w.SUGGESTED_WORKERS_AI_MODELS.filter((x) => x.recommended).length, 1);
});

test("a Workers AI model is saved, cleared with an empty string and checked for shape", async () => {
	const none = { provider: "workers-ai" };
	const picked = m.mergeAgentModelConfig(none, { workersAiModel: "@cf/zai-org/glm-5.3" });
	assert.equal(picked.workersAiModel, "@cf/zai-org/glm-5.3");
	assert.equal(m.mergeAgentModelConfig(picked, { model: "a/b" }).workersAiModel, "@cf/zai-org/glm-5.3");
	assert.equal(m.mergeAgentModelConfig(picked, { workersAiModel: "" }).workersAiModel, undefined);
	assert.deepEqual(m.mergeAgentModelConfig(none, { workersAiModel: "gpt-4o" }), { error: "Choose a Workers AI model from the list." });
	const env = { BUCKET: bucket() };
	await m.writeAgentModelConfig(env, picked);
	assert.equal(m.viewOf(await m.readAgentModelConfig(env)).workersAiModel, "@cf/zai-org/glm-5.3");
});

test("a saved model Cloudflare stopped listing falls back to the recommended one", () => {
	const catalog = [{ id: "@cf/zai-org/glm-5.3" }];
	assert.equal(m.resolveWorkersAiModel(undefined, catalog), m.WORKERS_AI_MODEL);
	assert.equal(m.resolveWorkersAiModel("@cf/zai-org/glm-5.3", catalog), "@cf/zai-org/glm-5.3");
	assert.equal(m.resolveWorkersAiModel("@cf/old/retired", catalog), m.WORKERS_AI_MODEL);
	assert.equal(m.resolveWorkersAiModel("@cf/old/retired", null), "@cf/old/retired");
});

test("the catalog keeps text models that call tools, suggested ones first with live prices", () => {
	const entry = (name, props, task = "Text Generation") => ({ name, task: { name: task }, properties: Object.entries(props).map(([property_id, value]) => ({ property_id, value })) });
	const price = (input, output) => [{ unit: "per M input tokens", price: input, currency: "USD" }, { unit: "per M output tokens", price: output, currency: "USD" }];
	const models = w.modelsFromCatalog([
		entry("@cf/zz/other", { function_calling: "true", context_window: "32000", price: price(0.1, 0.2) }),
		entry("@cf/zai-org/glm-5.3", { function_calling: "true", context_window: "1048576", price: price(2, 5) }),
		entry("@cf/moonshotai/kimi-k2.6", { function_calling: "true", context_window: "262144" }),
		entry("@cf/aa/no-tools", { context_window: "8000" }),
		entry("@cf/aa/embedder", { function_calling: "true" }, "Text Embeddings"),
	]);
	assert.deepEqual(models.map((x) => x.id), ["@cf/moonshotai/kimi-k2.6", "@cf/zai-org/glm-5.3", "@cf/zz/other"]);
	assert.deepEqual(models[1].price, { input: 2, output: 5 });
	assert.equal(models[1].note, w.SUGGESTED_WORKERS_AI_MODELS[1].note);
	assert.deepEqual(models[0].price, w.SUGGESTED_WORKERS_AI_MODELS[0].price, "no live price keeps the saved one");
	assert.deepEqual(models[2], { id: "@cf/zz/other", name: "Other", note: "", context: 32000, price: { input: 0.1, output: 0.2 }, suggested: false });
});

test("catalog ids read as names, and each maker gets a label and hue", () => {
	assert.equal(w.prettyName("@cf/zai-org/glm-5.2"), "GLM 5.2");
	assert.equal(w.prettyName("@cf/openai/gpt-oss-20b"), "GPT OSS 20B");
	assert.equal(w.prettyName("@cf/meta/llama-3.3-70b-instruct-fp8-fast"), "Llama 3.3 70B Instruct FP8 Fast");
	assert.equal(w.prettyName("@cf/moonshotai/kimi-k2.7-code"), "Kimi K2.7 Code");
	assert.equal(w.prettyName("@cf/deepseek-ai/deepseek-v4-pro-0813"), "DeepSeek V4 Pro 0813");
	assert.equal(w.makerOf("@cf/zai-org/glm-5.2").label, "Z.ai");
	const unknown = w.makerOf("@cf/someone/model");
	assert.equal(unknown.label, "someone");
	assert.equal(unknown.hue, w.makerOf("@cf/someone/other").hue);
});
