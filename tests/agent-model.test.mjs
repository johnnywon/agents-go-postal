import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTs } from "./helpers/sqlite.mjs";

const m = await loadTs("workers/lib/agent-model.ts");
const s = await loadTs("shared/models.ts");

function bucket() {
	const store = new Map();
	return {
		store,
		get: async (k) => (store.has(k) ? { json: async () => JSON.parse(store.get(k)) } : null),
		put: async (k, v) => { store.set(k, v); },
	};
}

test("with nothing saved the agent runs the recommended Workers AI model", async () => {
	const config = await m.readAgentModelConfig({ BUCKET: bucket() });
	assert.deepEqual(config, { keys: {} });
	const view = m.viewOf(config);
	assert.equal(view.selected, null);
	assert.deepEqual(view.active, s.RECOMMENDED_MODEL);
	assert.equal(view.active.provider, "workers-ai");
	assert.equal(m.WORKERS_AI_MODEL, s.RECOMMENDED_MODEL.id);
	assert.equal(s.SUGGESTED_MODELS.filter((x) => x.recommended).length, 1);
	// One model per need: every suggestion has its own role.
	const roles = s.SUGGESTED_MODELS.map((x) => x.role);
	assert.ok(roles.every(Boolean));
	assert.equal(new Set(roles).size, roles.length);
});

test("the older one-provider file still reads", () => {
	assert.deepEqual(m.parseAgentModelConfig({ provider: "openrouter", model: "a/b", apiKey: "sk-or-1234567890" }), {
		selected: { provider: "openrouter", id: "a/b" }, keys: { openrouter: "sk-or-1234567890" },
	});
	assert.deepEqual(m.parseAgentModelConfig({ provider: "workers-ai", model: "a/b", apiKey: "sk-or-1234567890", workersAiModel: "@cf/zai-org/glm-5.3" }), {
		selected: { provider: "workers-ai", id: "@cf/zai-org/glm-5.3" }, keys: { openrouter: "sk-or-1234567890" },
	});
	assert.deepEqual(m.parseAgentModelConfig({ provider: "workers-ai" }), { keys: {} });
});

test("the view never carries a key, only its last four characters", () => {
	const view = m.viewOf({ keys: { anthropic: "sk-ant-api03-0123456789abcd" } });
	assert.deepEqual(view.keys.anthropic, { set: true, hint: "abcd" });
	assert.deepEqual(view.keys.openai, { set: false, hint: "" });
	assert.ok(!JSON.stringify(view).includes("sk-ant"));
});

test("any id shaped right for its provider is accepted; a keyed provider needs its key", () => {
	const none = { keys: {} };
	assert.deepEqual(m.mergeAgentModelConfig(none, { selected: { provider: "anthropic", id: "claude-fable-5-1" } }), { error: "Add your Anthropic key." });
	const ok = m.mergeAgentModelConfig(none, { selected: { provider: "anthropic", id: "claude-anything-new" }, keys: { anthropic: " sk-ant-x " } });
	assert.deepEqual(ok, { selected: { provider: "anthropic", id: "claude-anything-new" }, keys: { anthropic: "sk-ant-x" } });
	assert.equal(m.mergeAgentModelConfig(none, { selected: { provider: "workers-ai", id: "@cf/someone/brand-new" } }).selected.id, "@cf/someone/brand-new");
	assert.match(m.mergeAgentModelConfig(none, { selected: { provider: "workers-ai", id: "gpt-6" } }).error, /Cloudflare model id/);
	assert.match(m.mergeAgentModelConfig(none, { selected: { provider: "openrouter", id: "no slash" } }).error, /OpenRouter model id/);
});

test("keys are kept, replaced or removed per provider, and null goes back to the recommended model", () => {
	const current = { selected: { provider: "openai", id: "gpt-6-astra" }, keys: { openai: "sk-old", xai: "xai-old" } };
	assert.deepEqual(m.mergeAgentModelConfig(current, { keys: { xai: "" } }), { selected: current.selected, keys: { openai: "sk-old" } });
	assert.deepEqual(m.mergeAgentModelConfig(current, { keys: { openai: "sk-new" } }).keys, { openai: "sk-new", xai: "xai-old" });
	assert.deepEqual(m.mergeAgentModelConfig(current, { selected: null }), { keys: current.keys });
	assert.deepEqual(m.mergeAgentModelConfig(current, { keys: { openai: "" } }), { error: "Add your OpenAI key." });
});

test("a picked model without its key runs the recommended one", () => {
	assert.deepEqual(m.activeModel({ selected: { provider: "xai", id: "grok-4.7" }, keys: {} }), s.RECOMMENDED_MODEL);
	assert.deepEqual(m.activeModel({ selected: { provider: "xai", id: "grok-4.7" }, keys: { xai: "k" } }), { provider: "xai", id: "grok-4.7" });
});

test("a Workers AI model Cloudflare stopped listing falls back to the recommended one", () => {
	const catalog = [{ provider: "workers-ai", id: "@cf/zai-org/glm-5.3" }];
	assert.deepEqual(m.resolveWorkersAiModel("@cf/zai-org/glm-5.3", catalog), { provider: "workers-ai", id: "@cf/zai-org/glm-5.3" });
	assert.deepEqual(m.resolveWorkersAiModel("@cf/old/retired", catalog), s.RECOMMENDED_MODEL);
	assert.deepEqual(m.resolveWorkersAiModel("@cf/old/retired", null), { provider: "workers-ai", id: "@cf/old/retired" });
});

test("config round-trips through R2", async () => {
	const env = { BUCKET: bucket() };
	const config = { selected: { provider: "openai", id: "gpt-6-astra" }, keys: { openai: "sk-1" } };
	await m.writeAgentModelConfig(env, config);
	assert.deepEqual(await m.readAgentModelConfig(env), config);
});

test("Cloudflare's catalog keeps text models and marks which call tools", () => {
	const entry = (name, props, task = "Text Generation") => ({ name, task: { name: task }, properties: Object.entries(props).map(([property_id, value]) => ({ property_id, value })) });
	const price = [{ unit: "per M input tokens", price: 0.1 }, { unit: "per M output tokens", price: 0.2 }];
	const models = s.modelsFromWorkersAi([
		entry("@cf/zz/other", { function_calling: "true", context_window: "32000", price }),
		entry("@cf/aa/no-tools", { context_window: "8000" }),
		entry("@cf/aa/embedder", { function_calling: "true" }, "Text Embeddings"),
	]);
	assert.deepEqual(models, [
		{ provider: "workers-ai", id: "@cf/zz/other", name: "Other", context: 32000, price: { input: 0.1, output: 0.2 }, tools: true },
		{ provider: "workers-ai", id: "@cf/aa/no-tools", name: "No Tools", context: 8000, price: null, tools: false },
	]);
});

test("OpenRouter prices per token become per million, and direct providers borrow them", () => {
	const or = s.modelsFromOpenRouter([
		{ id: "anthropic/claude-sonnet-5.5", name: "Anthropic: Claude Sonnet 5.5", context_length: 1000000, pricing: { prompt: "0.000002", completion: "0.00001" }, supported_parameters: ["tools"] },
		{ id: "anthropic/claude-sonnet-5.5:batch", pricing: { prompt: "0.000001", completion: "0.000005" } },
		{ id: "openai/gpt-6-luna", name: "OpenAI: GPT-6 Luna", context_length: 1050000, pricing: { prompt: "0.0000001", completion: "0.0000005" }, supported_parameters: [] },
	]);
	assert.deepEqual(or[0], { provider: "openrouter", id: "anthropic/claude-sonnet-5.5", name: "Claude Sonnet 5.5", context: 1000000, price: { input: 2, output: 10 }, tools: true });
	assert.equal(or[2].tools, false);
	const anthropic = s.directFromOpenRouter("anthropic", or);
	assert.deepEqual(anthropic.map((x) => x.id), ["claude-sonnet-5-5"]);
	const live = [{ provider: "anthropic", id: "claude-sonnet-5-5-20260928", name: "Claude Sonnet 5.5", context: null, price: null, tools: true }];
	assert.deepEqual(s.enrich(live, anthropic)[0].price, { input: 2, output: 10 });
	assert.deepEqual(s.directFromOpenRouter("openai", or).map((x) => x.id), ["gpt-6-luna"]);
});

test("typed ids go to the provider they look like, and names read well", () => {
	assert.equal(s.guessProvider("@cf/meta/llama"), "workers-ai");
	assert.equal(s.guessProvider("anthropic/claude-fable-5.1"), "openrouter");
	assert.equal(s.guessProvider("claude-fable-5-1"), "anthropic");
	assert.equal(s.guessProvider("grok-4.7"), "xai");
	assert.equal(s.guessProvider("gpt-6-astra"), "openai");
	assert.deepEqual(s.chatModelsOnly(["gpt-6-astra", "text-embedding-3-large", "whisper-1", "o5-mini", "gpt-image-2"]), ["gpt-6-astra", "o5-mini"]);
	assert.equal(s.prettyName("@cf/deepseek-ai/deepseek-v4-pro-0813"), "DeepSeek V4 Pro 0813");
	assert.equal(s.prettyName("@cf/openai/gpt-oss-20b"), "GPT OSS 20B");
	assert.equal(s.makerOf({ provider: "openrouter", id: "x-ai/grok-4.7" }).label, "xAI");
	assert.equal(s.makerOf({ provider: "workers-ai", id: "@cf/zai-org/glm-5.2" }).label, "Z.ai");
});

test("free models are never offered or accepted", () => {
	assert.equal(s.isFree({ id: "maker/model:free", price: { input: 1, output: 1 } }), true);
	assert.equal(s.isFree({ id: "maker/model", price: { input: 0, output: 0 } }), true);
	assert.equal(s.isFree({ id: "maker/model", price: null }), false);
	assert.equal(s.validModelId("openrouter", "maker/model:free"), false);
	assert.ok("error" in m.mergeAgentModelConfig({ keys: { openrouter: "sk-or-x" } }, { selected: { provider: "openrouter", id: "maker/model:free" } }));
});

test("OpenRouter lists only zero retention models, priced at their cheapest such endpoint", () => {
	const all = s.modelsFromOpenRouter([
		{ id: "a/kept", pricing: { prompt: "0.000001", completion: "0.000002" } },
		{ id: "a/private", pricing: { prompt: "0.000001", completion: "0.000002" } },
		{ id: "a/gratis", pricing: { prompt: "0", completion: "0" } },
	]);
	const zdr = s.zdrOnly(all, [
		{ model_id: "a/private", pricing: { prompt: "0.000003", completion: "0.000009" } },
		{ model_id: "a/private", pricing: { prompt: "0.000002", completion: "0.000004" } },
		{ model_id: "a/gratis", pricing: { prompt: "0", completion: "0" } },
	]);
	assert.deepEqual(zdr.map((x) => x.id), ["a/private"]);
	assert.deepEqual(zdr[0].price, { input: 2, output: 4 });
});

test("every OpenRouter request asks for zero retention and no data collection", async () => {
	const real = globalThis.fetch;
	let sent;
	globalThis.fetch = async (_url, init) => { sent = JSON.parse(init.body); return new Response("{}"); };
	try {
		await m.zeroRetentionFetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "a/b", provider: { order: ["x"] } }) });
	} finally {
		globalThis.fetch = real;
	}
	assert.deepEqual(sent.provider, { order: ["x"], zdr: true, data_collection: "deny" });
});

test("suggestions that need a key go through a zero retention provider", () => {
	for (const pick of s.SUGGESTED_MODELS) {
		if (pick.provider !== "workers-ai") assert.ok(s.PROVIDER_INFO[pick.provider].zdr, pick.id);
	}
});
