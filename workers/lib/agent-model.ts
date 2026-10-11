// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Which model runs the agent. Workers AI by default; an OpenRouter API key
 * set in Settings moves the chat agent and auto-draft onto OpenRouter.
 *
 * The key is stored in R2 under config/, which no route serves. The API only
 * ever returns its last four characters.
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import type { Env } from "../types";

export const WORKERS_AI_MODEL = "@cf/moonshotai/kimi-k2.5";
export const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const CONFIG_KEY = "config/agent-model.json";

export type AgentProvider = "workers-ai" | "openrouter";

export interface AgentModelConfig {
	provider: AgentProvider;
	model?: string;
	apiKey?: string;
}

/** What the browser sees: never the key itself. */
export interface AgentModelView {
	provider: AgentProvider;
	model: string;
	keySet: boolean;
	keyHint: string;
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
		defaultModel: WORKERS_AI_MODEL,
	};
}

/**
 * Merge a settings update. apiKey: undefined keeps the stored key, "" removes it.
 * Choosing OpenRouter needs a key and a model.
 */
export function mergeAgentModelConfig(
	current: AgentModelConfig,
	update: { provider?: string; model?: string; apiKey?: string },
): AgentModelConfig | { error: string } {
	const provider: AgentProvider = update.provider === "openrouter" ? "openrouter" : update.provider === "workers-ai" ? "workers-ai" : current.provider;
	const apiKey = update.apiKey === undefined ? current.apiKey : update.apiKey.trim() || undefined;
	const model = (update.model ?? current.model ?? "").trim() || undefined;
	if (provider === "openrouter") {
		if (!apiKey) return { error: "Add an OpenRouter API key." };
		if (!model) return { error: "Choose an OpenRouter model." };
	}
	return { provider, model, apiKey };
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

/** The model the agent should use right now. */
export async function agentModel(env: Env): Promise<LanguageModel> {
	const config = await readAgentModelConfig(env);
	if (config.provider === "openrouter" && config.apiKey && config.model) {
		return openRouterModel(config.apiKey, config.model);
	}
	return createWorkersAI({ binding: env.AI })(WORKERS_AI_MODEL);
}
