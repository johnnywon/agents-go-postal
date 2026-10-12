// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Which model runs the agent, on which provider: Workers AI (Cloudflare),
 * OpenRouter, Anthropic, OpenAI or xAI. Until Settings picks a model, the
 * agent follows RECOMMENDED_MODEL in shared/models.ts.
 *
 * Keys are stored in R2 under config/, which no route serves. The API only
 * ever returns their last four characters.
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createXai } from "@ai-sdk/xai";
import type { LanguageModel } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import {
	type CatalogModel, chatModelsOnly, directFromOpenRouter, enrich, isProvider, KEYED_PROVIDERS, type KeyedProvider,
	type ModelRef, modelsFromOpenRouter, modelsFromWorkersAi, type OpenRouterEntry, PROVIDER_INFO, type ProviderId,
	prettyName, RECOMMENDED_MODEL, validModelId, type WorkersAiEntry,
} from "../../shared/models";
import type { Env } from "../types";

export const WORKERS_AI_MODEL = RECOMMENDED_MODEL.id;
export const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const CONFIG_KEY = "config/agent-model.json";

export type Keys = Partial<Record<KeyedProvider, string>>;

export interface AgentModelConfig {
	/** The picked model. Unset follows the recommended one. */
	selected?: ModelRef;
	keys: Keys;
}

/** What the browser sees: never a key, only whether one is saved and its last four characters. */
export interface AgentModelView {
	selected: ModelRef | null;
	recommended: ModelRef;
	/** The model the agent runs right now. */
	active: ModelRef;
	keys: Record<KeyedProvider, { set: boolean; hint: string }>;
}

/** Reads the current file, and the older one-provider shape ({ provider, model, apiKey, workersAiModel }). */
export function parseAgentModelConfig(raw: unknown): AgentModelConfig {
	const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
	const keys: Keys = {};
	if (r.keys && typeof r.keys === "object") {
		for (const p of KEYED_PROVIDERS) {
			const k = str((r.keys as Record<string, unknown>)[p]);
			if (k) keys[p] = k;
		}
	}
	let selected: ModelRef | undefined;
	const sel = r.selected as Record<string, unknown> | undefined;
	if (sel && isProvider(sel.provider) && str(sel.id)) selected = { provider: sel.provider, id: str(sel.id)! };

	if (!r.keys && !r.selected) {
		const apiKey = str(r.apiKey);
		if (apiKey) keys.openrouter = apiKey;
		const model = str(r.model);
		const workersAiModel = str(r.workersAiModel);
		if (r.provider === "openrouter" && apiKey && model) selected = { provider: "openrouter", id: model };
		else if (workersAiModel) selected = { provider: "workers-ai", id: workersAiModel };
	}
	return selected ? { selected, keys } : { keys };
}

export async function readAgentModelConfig(env: Env): Promise<AgentModelConfig> {
	const obj = await env.BUCKET.get(CONFIG_KEY);
	if (!obj) return { keys: {} };
	try {
		return parseAgentModelConfig(await obj.json());
	} catch {
		return { keys: {} };
	}
}

export async function writeAgentModelConfig(env: Env, config: AgentModelConfig): Promise<void> {
	await env.BUCKET.put(CONFIG_KEY, JSON.stringify(config), {
		httpMetadata: { contentType: "application/json" },
	});
}

/** The picked model when it can run (Workers AI, or a provider with a saved key), else the recommended one. */
export function activeModel(config: AgentModelConfig): ModelRef {
	const s = config.selected;
	if (!s) return RECOMMENDED_MODEL;
	if (s.provider === "workers-ai" || config.keys[s.provider]) return s;
	return RECOMMENDED_MODEL;
}

export function viewOf(config: AgentModelConfig): AgentModelView {
	const keys = {} as AgentModelView["keys"];
	for (const p of KEYED_PROVIDERS) {
		const k = config.keys[p] ?? "";
		keys[p] = { set: k.length > 0, hint: k.length > 8 ? k.slice(-4) : "" };
	}
	return { selected: config.selected ?? null, recommended: RECOMMENDED_MODEL, active: activeModel(config), keys };
}

export interface AgentModelUpdate {
	/** null goes back to the recommended model. */
	selected?: ModelRef | null;
	/** A key per provider; "" removes it, a missing provider keeps its key. */
	keys?: Partial<Record<string, string>>;
}

/** Merge a settings update. Any model id shaped right for its provider is allowed; a keyed provider needs its key. */
export function mergeAgentModelConfig(current: AgentModelConfig, update: AgentModelUpdate): AgentModelConfig | { error: string } {
	const keys: Keys = { ...current.keys };
	for (const p of KEYED_PROVIDERS) {
		const k = update.keys?.[p];
		if (k === undefined) continue;
		if (k.trim()) keys[p] = k.trim();
		else delete keys[p];
	}
	let selected = update.selected === undefined ? current.selected : update.selected ?? undefined;
	if (selected) {
		const id = selected.id.trim();
		if (!isProvider(selected.provider)) return { error: "Choose a provider." };
		if (!validModelId(selected.provider, id)) return { error: `That isn't a ${PROVIDER_INFO[selected.provider].label} model id. They look like ${PROVIDER_INFO[selected.provider].idExample}.` };
		if (selected.provider !== "workers-ai" && !keys[selected.provider]) return { error: `Add your ${PROVIDER_INFO[selected.provider].label} key.` };
		selected = { provider: selected.provider, id };
	}
	return selected ? { selected, keys } : { keys };
}

/** A language model for any provider. */
export function languageModel(env: Env, ref: ModelRef, key?: string): LanguageModel {
	switch (ref.provider) {
		case "openrouter":
			return createOpenAICompatible({ name: "openrouter", baseURL: OPENROUTER_BASE, apiKey: key, headers: { "X-Title": "Agents Go Postal" } }).chatModel(ref.id);
		case "anthropic":
			return createAnthropic({ apiKey: key })(ref.id);
		case "openai":
			return createOpenAI({ apiKey: key })(ref.id);
		case "xai":
			return createXai({ apiKey: key })(ref.id);
		default:
			return createWorkersAI({ binding: env.AI })(ref.id as Parameters<ReturnType<typeof createWorkersAI>>[0]);
	}
}

/**
 * Turning plain words into a search is one short structured answer. The
 * default agent model reasons first and took 10 to 27 s for it, so on
 * Workers AI this smaller model that answers directly does it instead.
 */
export const WORKERS_AI_FAST_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** The model for short structured answers: the picked model on another provider, else the fast Workers AI model. */
export async function quickModel(env: Env): Promise<LanguageModel> {
	const config = await readAgentModelConfig(env);
	const active = activeModel(config);
	if (active.provider !== "workers-ai") return languageModel(env, active, config.keys[active.provider]);
	return languageModel(env, { provider: "workers-ai", id: WORKERS_AI_FAST_MODEL });
}

/** The model the agent should use right now. */
export async function agentModel(env: Env): Promise<LanguageModel> {
	const config = await readAgentModelConfig(env);
	let active = activeModel(config);
	if (active.provider === "workers-ai" && active.id !== WORKERS_AI_MODEL) {
		active = resolveWorkersAiModel(active.id, (await catalogFor(env, "workers-ai", config.keys)).models);
	}
	return languageModel(env, active, active.provider === "workers-ai" ? undefined : config.keys[active.provider]);
}

/**
 * A Workers AI model Cloudflare stopped listing falls back to the recommended
 * one. When the catalog can't be read, the saved model is trusted.
 */
export function resolveWorkersAiModel(saved: string, catalog: CatalogModel[] | null): ModelRef {
	if (catalog && catalog.length > 0 && !catalog.some((m) => m.id === saved)) return RECOMMENDED_MODEL;
	return { provider: "workers-ai", id: saved };
}

// -- Catalogs ---------------------------------------------------------

export interface ProviderCatalog {
	/** "live": from the provider. "openrouter": from OpenRouter's listing of the provider's models, because there's no key or the provider's list failed. */
	source: "live" | "openrouter" | "none";
	models: CatalogModel[];
	error?: string;
}

const CATALOG_TTL_MS = 3_600_000;
const cache = new Map<string, { at: number; value: ProviderCatalog }>();

/** Forget cached lists, for example after a key changes. */
export function clearCatalogCache(): void {
	cache.clear();
}

async function cached(key: string, load: () => Promise<ProviderCatalog>, now = Date.now()): Promise<ProviderCatalog> {
	const hit = cache.get(key);
	if (hit && now - hit.at < CATALOG_TTL_MS) return hit.value;
	const value = await load();
	if (value.source !== "none") cache.set(key, { at: now, value });
	return value;
}

async function fetchJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
	const res = await fetch(url, { headers });
	if (!res.ok) throw new Error(`${res.status} ${res.statusText}`.trim());
	return res.json();
}

async function loadWorkersAi(env: Env): Promise<ProviderCatalog> {
	try {
		const entries: WorkersAiEntry[] = [];
		for (let page = 1; page <= 10; page++) {
			const batch = (await env.AI.models({ page, per_page: 100 })) as WorkersAiEntry[];
			entries.push(...batch);
			if (batch.length < 100) break;
		}
		const models = modelsFromWorkersAi(entries);
		return models.length ? { source: "live", models } : { source: "none", models: [], error: "Cloudflare's catalog came back empty." };
	} catch (e) {
		return { source: "none", models: [], error: `Cloudflare's catalog couldn't be read: ${(e as Error).message}` };
	}
}

async function loadOpenRouter(): Promise<ProviderCatalog> {
	try {
		const data = (await fetchJson(`${OPENROUTER_BASE}/models`)) as { data?: OpenRouterEntry[] };
		return { source: "live", models: modelsFromOpenRouter(data.data ?? []) };
	} catch (e) {
		return { source: "none", models: [], error: `OpenRouter's catalog couldn't be read: ${(e as Error).message}` };
	}
}

/** A direct provider's own list, read with its key. */
async function loadDirect(provider: KeyedProvider, key: string): Promise<CatalogModel[]> {
	if (provider === "anthropic") {
		const data = (await fetchJson("https://api.anthropic.com/v1/models?limit=1000", { "x-api-key": key, "anthropic-version": "2023-06-01" })) as {
			data?: { id: string; display_name?: string; max_input_tokens?: number }[];
		};
		return (data.data ?? []).map((m) => ({ provider, id: m.id, name: m.display_name ?? prettyName(m.id), context: m.max_input_tokens ?? null, price: null, tools: true }));
	}
	const base = provider === "openai" ? "https://api.openai.com/v1" : "https://api.x.ai/v1";
	const data = (await fetchJson(`${base}/models`, { Authorization: `Bearer ${key}` })) as { data?: { id: string; created?: number }[] };
	const newestFirst = [...(data.data ?? [])].sort((a, b) => (b.created ?? 0) - (a.created ?? 0)).map((m) => m.id);
	return chatModelsOnly(newestFirst).map((id) => ({ provider, id, name: prettyName(id), context: null, price: null, tools: null }));
}

export async function catalogFor(env: Env, provider: ProviderId, keys: Keys): Promise<ProviderCatalog> {
	if (provider === "workers-ai") return cached("workers-ai", () => loadWorkersAi(env));
	const openrouter = await cached("openrouter", loadOpenRouter);
	if (provider === "openrouter") return openrouter;
	const fallback = directFromOpenRouter(provider, openrouter.models);
	const key = keys[provider];
	if (!key) return { source: fallback.length ? "openrouter" : "none", models: fallback };
	return cached(`${provider}:${key.slice(-6)}`, async () => {
		try {
			return { source: "live", models: enrich(await loadDirect(provider, key), fallback) };
		} catch (e) {
			return { source: fallback.length ? "openrouter" : "none", models: fallback, error: `${PROVIDER_INFO[provider].label} didn't list models: ${(e as Error).message}` };
		}
	});
}
