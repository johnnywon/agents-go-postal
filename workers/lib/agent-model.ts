// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Which model runs the agent. Workers AI by default, on the recommended model
 * in shared/workers-ai-models.ts unless Settings picked another one. An
 * OpenRouter API key set in Settings moves the chat agent and auto-draft onto
 * OpenRouter.
 *
 * The key is stored in R2 under config/, which no route serves. The API only
 * ever returns its last four characters.
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { type CatalogEntry, modelsFromCatalog, RECOMMENDED_WORKERS_AI_MODEL, type WorkersAiModel } from "../../shared/workers-ai-models";
import type { Env } from "../types";

export const WORKERS_AI_MODEL = RECOMMENDED_WORKERS_AI_MODEL;
export const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const CONFIG_KEY = "config/agent-model.json";

export type AgentProvider = "workers-ai" | "openrouter";

export interface AgentModelConfig {
	provider: AgentProvider;
	/** The OpenRouter model. */
	model?: string;
	apiKey?: string;
	/** The Workers AI model. Unset follows the recommended one. */
	workersAiModel?: string;
}

/** What the browser sees: never the key itself. */
export interface AgentModelView {
	provider: AgentProvider;
	model: string;
	keySet: boolean;
	keyHint: string;
	/** The saved Workers AI model, or "" to follow the recommended one. */
	workersAiModel: string;
	defaultModel: string;
}

export async function readAgentModelConfig(env: Env): Promise<AgentModelConfig> {
	const obj = await env.BUCKET.get(CONFIG_KEY);
	if (!obj) return { provider: "workers-ai" };
	try {
		const parsed = (await obj.json()) as Partial<AgentModelConfig>;
		return {
			provider: parsed.provider === "openrouter" ? "openrouter" : "workers-ai",
			model: typeof parsed.model === "string" ? parsed.model : undefined,
			apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : undefined,
			...(typeof parsed.workersAiModel === "string" && parsed.workersAiModel ? { workersAiModel: parsed.workersAiModel } : {}),
		};
	} catch {
		return { provider: "workers-ai" };
	}
}

export async function writeAgentModelConfig(env: Env, config: AgentModelConfig): Promise<void> {
	await env.BUCKET.put(CONFIG_KEY, JSON.stringify(config), {
		httpMetadata: { contentType: "application/json" },
	});
}

export function viewOf(config: AgentModelConfig): AgentModelView {
	const key = config.apiKey ?? "";
	return {
		provider: config.provider,
		model: config.model ?? "",
		keySet: key.length > 0,
		keyHint: key.length > 8 ? key.slice(-4) : "",
		workersAiModel: config.workersAiModel ?? "",
		defaultModel: WORKERS_AI_MODEL,
	};
}

/** Workers AI model ids look like "@cf/author/name" or "@hf/author/name". */
const WORKERS_AI_ID = /^@(cf|hf)\/[\w.-]+\/[\w.:-]+$/;

/**
 * Merge a settings update. apiKey: undefined keeps the stored key, "" removes it.
 * workersAiModel works the same way: "" goes back to the recommended model.
 * Choosing OpenRouter needs a key and a model.
 */
export function mergeAgentModelConfig(
	current: AgentModelConfig,
	update: { provider?: string; model?: string; apiKey?: string; workersAiModel?: string },
): AgentModelConfig | { error: string } {
	const provider: AgentProvider = update.provider === "openrouter" ? "openrouter" : update.provider === "workers-ai" ? "workers-ai" : current.provider;
	const apiKey = update.apiKey === undefined ? current.apiKey : update.apiKey.trim() || undefined;
	const model = (update.model ?? current.model ?? "").trim() || undefined;
	const workersAiModel = update.workersAiModel === undefined ? current.workersAiModel : update.workersAiModel.trim() || undefined;
	if (workersAiModel && !WORKERS_AI_ID.test(workersAiModel)) return { error: "Choose a Workers AI model from the list." };
	if (provider === "openrouter") {
		if (!apiKey) return { error: "Add an OpenRouter API key." };
		if (!model) return { error: "Choose an OpenRouter model." };
	}
	return { provider, model, apiKey, workersAiModel };
}

export function openRouterModel(apiKey: string, model: string): LanguageModel {
	const openrouter = createOpenAICompatible({
		name: "openrouter",
		baseURL: OPENROUTER_BASE,
		apiKey,
		headers: { "X-Title": "Agents Go Postal" },
	});
	return openrouter.chatModel(model);
}

/**
 * Turning plain words into a search is one short structured answer. The
 * default agent model reasons first and took 10 to 27 s for it, so on
 * Workers AI this smaller model that answers directly does it instead.
 */
export const WORKERS_AI_FAST_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** The model for short structured answers: OpenRouter's model when chosen, else the fast Workers AI model. */
export async function quickModel(env: Env): Promise<LanguageModel> {
	const config = await readAgentModelConfig(env);
	if (config.provider === "openrouter" && config.apiKey && config.model) {
		return openRouterModel(config.apiKey, config.model);
	}
	return createWorkersAI({ binding: env.AI })(WORKERS_AI_FAST_MODEL);
}

const CATALOG_TTL_MS = 3_600_000;
let catalogCache: { at: number; models: WorkersAiModel[] } | null = null;

/**
 * Cloudflare's text models that can call tools, with live prices and context
 * sizes. Cached for an hour per isolate. Null when the catalog can't be read,
 * for example in local development without a remote AI binding.
 */
export async function workersAiCatalog(env: Env, now = Date.now()): Promise<WorkersAiModel[] | null> {
	if (catalogCache && now - catalogCache.at < CATALOG_TTL_MS) return catalogCache.models;
	try {
		const entries: CatalogEntry[] = [];
		for (let page = 1; page <= 10; page++) {
			const batch = (await env.AI.models({ page, per_page: 100 })) as CatalogEntry[];
			entries.push(...batch);
			if (batch.length < 100) break;
		}
		const models = modelsFromCatalog(entries);
		if (models.length === 0) return null;
		catalogCache = { at: now, models };
		return models;
	} catch {
		return null;
	}
}

/**
 * The Workers AI model to run: the saved one while Cloudflare still lists it,
 * otherwise the recommended one. When the catalog can't be read, the saved
 * model is trusted.
 */
export function resolveWorkersAiModel(saved: string | undefined, catalog: WorkersAiModel[] | null): string {
	if (!saved) return WORKERS_AI_MODEL;
	if (catalog && !catalog.some((m) => m.id === saved)) return WORKERS_AI_MODEL;
	return saved;
}

/** The model the agent should use right now. */
export async function agentModel(env: Env): Promise<LanguageModel> {
	const config = await readAgentModelConfig(env);
	if (config.provider === "openrouter" && config.apiKey && config.model) {
		return openRouterModel(config.apiKey, config.model);
	}
	const id = config.workersAiModel ? resolveWorkersAiModel(config.workersAiModel, await workersAiCatalog(env)) : WORKERS_AI_MODEL;
	return createWorkersAI({ binding: env.AI })(id as Parameters<ReturnType<typeof createWorkersAI>>[0]);
}
