/**
 * The agent's model providers and catalogs, shared by the Worker and Settings.
 *
 * Every provider's full list is offered, and any model id can be typed in.
 * SUGGESTED_MODELS is the short list shown first, one model per need, each
 * with the role it fills. `recommended` marks the default that deployments
 * follow until they pick something else.
 */

export const PROVIDERS = ["workers-ai", "openrouter", "anthropic", "openai", "xai"] as const;
export type ProviderId = (typeof PROVIDERS)[number];
export type KeyedProvider = Exclude<ProviderId, "workers-ai">;
export const KEYED_PROVIDERS: KeyedProvider[] = ["openrouter", "anthropic", "openai", "xai"];

export interface ProviderInfo {
	id: ProviderId;
	label: string;
	/** Hue for the provider's tag. */
	hue: number;
	/** Placeholder for the key field; null when no key is needed. */
	keyHint: string | null;
	/** Where to get a key. */
	keyUrl: string | null;
	/** What a model id looks like, for typed-in ids. */
	idExample: string;
}

export const PROVIDER_INFO: Record<ProviderId, ProviderInfo> = {
	"workers-ai": { id: "workers-ai", label: "Cloudflare", hue: 55, keyHint: null, keyUrl: null, idExample: "@cf/author/model" },
	openrouter: { id: "openrouter", label: "OpenRouter", hue: 265, keyHint: "sk-or-…", keyUrl: "https://openrouter.ai/settings/keys", idExample: "maker/model" },
	anthropic: { id: "anthropic", label: "Anthropic", hue: 35, keyHint: "sk-ant-…", keyUrl: "https://console.anthropic.com/settings/keys", idExample: "claude-…" },
	openai: { id: "openai", label: "OpenAI", hue: 160, keyHint: "sk-…", keyUrl: "https://platform.openai.com/api-keys", idExample: "gpt-…" },
	xai: { id: "xai", label: "xAI", hue: 235, keyHint: "xai-…", keyUrl: "https://console.x.ai", idExample: "grok-…" },
};

export function isProvider(value: unknown): value is ProviderId {
	return typeof value === "string" && (PROVIDERS as readonly string[]).includes(value);
}

export interface ModelPrice {
	/** USD per million input tokens. */
	input: number;
	/** USD per million output tokens. */
	output: number;
}

export interface CatalogModel {
	provider: ProviderId;
	id: string;
	name: string;
	/** Tokens the model reads at once. */
	context: number | null;
	price: ModelPrice | null;
	/** Whether the catalog says the model can call tools; null when it doesn't say. */
	tools: boolean | null;
}

export interface ModelRef {
	provider: ProviderId;
	id: string;
}

export interface SuggestedModel extends ModelRef {
	/** The need it fills, shown above its name. */
	role: string;
	recommended?: boolean;
}

export const SUGGESTED_MODELS: SuggestedModel[] = [
	// Built in, no key, reliable tool calls at a mid price.
	{ provider: "workers-ai", id: "@cf/moonshotai/kimi-k2.6", role: "Recommended", recommended: true },
	// Built in, the lowest output price of the tool-calling models, 1M context.
	{ provider: "workers-ai", id: "@cf/zai-org/glm-5.3-flash", role: "Cheapest" },
	// Strong drafting and tool use at a fifth of the top model's price.
	{ provider: "anthropic", id: "claude-sonnet-5-5", role: "Balanced" },
	// The most capable, for hard threads, at the highest price.
	{ provider: "anthropic", id: "claude-fable-5-1", role: "Best quality" },
];

const recommended = SUGGESTED_MODELS.find((m) => m.recommended)!;
export const RECOMMENDED_MODEL: ModelRef = { provider: recommended.provider, id: recommended.id };

export function sameModel(a: ModelRef, b: ModelRef): boolean {
	return a.provider === b.provider && a.id === b.id;
}

/** What a typed id looks like it belongs to. */
export function guessProvider(id: string): ProviderId {
	const s = id.trim().toLowerCase();
	if (/^@(cf|hf)\//.test(s)) return "workers-ai";
	if (s.includes("/")) return "openrouter";
	if (s.startsWith("claude")) return "anthropic";
	if (s.startsWith("grok")) return "xai";
	return "openai";
}

/** The shape check a model id must pass for its provider. Anything shaped right is allowed. */
export function validModelId(provider: ProviderId, id: string): boolean {
	if (!id || id.length > 200 || /\s/.test(id)) return false;
	if (provider === "workers-ai") return /^@(cf|hf)\/[\w.-]+\/[\w.:-]+$/.test(id);
	if (provider === "openrouter") return /^[\w.-]+\/[\w.:~-]+$/.test(id);
	return /^[\w.:-]+$/.test(id);
}

const UPPER = new Set(["glm", "gpt", "oss", "fp8", "awq", "it", "ai"]);
const SPELLED: Record<string, string> = { deepseek: "DeepSeek", eurollm: "EuroLLM" };

/** A readable name from a model id: "@cf/zai-org/glm-5.3-flash" becomes "GLM 5.3 Flash". */
export function prettyName(id: string): string {
	return (id.split("/").pop() ?? id).split(/[-:]/).filter(Boolean).map((w) =>
		SPELLED[w] ?? (UPPER.has(w) || /^\d+(\.\d+)?[bm]$/.test(w) || /^a\d+b$/.test(w) || /^[kv]\d/.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)),
	).join(" ");
}

/** Who makes a model, with a hue for its tag. */
const MAKERS: Record<string, { label: string; hue: number }> = {
	moonshotai: { label: "Moonshot", hue: 25 },
	"zai-org": { label: "Z.ai", hue: 175 },
	"z-ai": { label: "Z.ai", hue: 175 },
	"deepseek-ai": { label: "DeepSeek", hue: 255 },
	deepseek: { label: "DeepSeek", hue: 255 },
	openai: { label: "OpenAI", hue: 150 },
	anthropic: { label: "Anthropic", hue: 35 },
	"x-ai": { label: "xAI", hue: 235 },
	xai: { label: "xAI", hue: 235 },
	meta: { label: "Meta", hue: 230 },
	"meta-llama": { label: "Meta", hue: 230 },
	qwen: { label: "Qwen", hue: 295 },
	google: { label: "Google", hue: 75 },
	mistralai: { label: "Mistral", hue: 45 },
	nvidia: { label: "NVIDIA", hue: 125 },
	"ibm-granite": { label: "IBM", hue: 215 },
	"swiss-ai": { label: "Swiss AI", hue: 5 },
	"utter-project": { label: "EuroLLM", hue: 270 },
};

export function makerOf(model: ModelRef): { label: string; hue: number } {
	if (model.provider === "anthropic") return MAKERS.anthropic;
	if (model.provider === "openai") return MAKERS.openai;
	if (model.provider === "xai") return MAKERS.xai;
	const parts = model.id.split("/");
	const author = model.provider === "workers-ai" ? parts[1] ?? "" : parts[0] ?? "";
	if (MAKERS[author]) return MAKERS[author];
	let hue = 0;
	for (const c of author) hue = (hue * 31 + c.charCodeAt(0)) % 360;
	return { label: author || "Unknown", hue };
}

// -- Catalog parsing --------------------------------------------------

/** One entry of Cloudflare's model catalog, as env.AI.models() returns it. */
export interface WorkersAiEntry {
	name: string;
	task?: { name?: string };
	properties?: { property_id: string; value: unknown }[];
}

function workersAiPrice(value: unknown): ModelPrice | null {
	if (!Array.isArray(value)) return null;
	const find = (unit: string) => value.find((p) => p && typeof p === "object" && p.unit === unit && typeof p.price === "number")?.price as number | undefined;
	const input = find("per M input tokens");
	const output = find("per M output tokens");
	return input === undefined || output === undefined ? null : { input, output };
}

/** Cloudflare's text-generation models. `tools` says whether each can call tools. */
export function modelsFromWorkersAi(entries: WorkersAiEntry[]): CatalogModel[] {
	const out: CatalogModel[] = [];
	for (const entry of entries) {
		if (entry.task?.name !== "Text Generation") continue;
		const props = new Map((entry.properties ?? []).map((p) => [p.property_id, p.value]));
		const fc = props.get("function_calling");
		const context = Number(props.get("context_window"));
		out.push({
			provider: "workers-ai",
			id: entry.name,
			name: prettyName(entry.name),
			context: Number.isFinite(context) && context > 0 ? context : null,
			price: workersAiPrice(props.get("price")),
			tools: fc === true || fc === "true",
		});
	}
	return out;
}

/** One entry of OpenRouter's /models response. */
export interface OpenRouterEntry {
	id: string;
	name?: string;
	context_length?: number | null;
	pricing?: { prompt?: string; completion?: string };
	supported_parameters?: string[] | null;
}

function perMillion(value: string | undefined): number | undefined {
	const n = Number(value);
	return value === undefined || !Number.isFinite(n) || n < 0 ? undefined : Math.round(n * 1e6 * 1000) / 1000;
}

/** OpenRouter's catalog. Prices there are per token; here they are per million. */
export function modelsFromOpenRouter(entries: OpenRouterEntry[]): CatalogModel[] {
	return entries.filter((e) => typeof e.id === "string").map((e) => {
		const input = perMillion(e.pricing?.prompt);
		const output = perMillion(e.pricing?.completion);
		return {
			provider: "openrouter" as const,
			id: e.id,
			name: (e.name ?? prettyName(e.id)).replace(/^[^:]+:\s*/, ""),
			context: e.context_length && e.context_length > 0 ? e.context_length : null,
			price: input === undefined || output === undefined ? null : { input, output },
			tools: Array.isArray(e.supported_parameters) ? e.supported_parameters.includes("tools") : null,
		};
	});
}

/** Where each direct provider's models sit in OpenRouter's catalog. */
const OPENROUTER_PREFIX: Partial<Record<ProviderId, string>> = { anthropic: "anthropic/", openai: "openai/", xai: "x-ai/" };

/** "claude-sonnet-5.5", "claude-sonnet-5-5" and "claude-sonnet-5-5-20260928" all key as "claude-sonnet-5-5". */
function matchKey(id: string): string {
	return id.toLowerCase().replace(/\./g, "-").replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, "");
}

/**
 * A direct provider's models as OpenRouter lists them, for prices and context,
 * and for showing the list before a key is added. Variants like ":batch" are left out.
 */
export function directFromOpenRouter(provider: ProviderId, openrouter: CatalogModel[]): CatalogModel[] {
	const prefix = OPENROUTER_PREFIX[provider];
	if (!prefix) return [];
	return openrouter
		.filter((m) => m.id.startsWith(prefix) && !m.id.includes(":"))
		.map((m) => {
			const bare = m.id.slice(prefix.length);
			return { ...m, provider, id: provider === "anthropic" ? bare.replace(/\./g, "-") : bare };
		});
}

/** Fill in price and context for a direct provider's own list from OpenRouter's entries. */
export function enrich(models: CatalogModel[], reference: CatalogModel[]): CatalogModel[] {
	const byKey = new Map(reference.map((m) => [matchKey(m.id), m]));
	return models.map((m) => {
		const ref = byKey.get(matchKey(m.id));
		if (!ref) return m;
		return { ...m, context: m.context ?? ref.context, price: m.price ?? ref.price, tools: m.tools ?? ref.tools, name: m.name || ref.name };
	});
}

/** OpenAI's /models lists embeddings, audio and image models too; the agent needs a chat model. */
const NOT_CHAT = /embedding|tts|whisper|sora|dall-e|gpt-image|image|audio|realtime|transcribe|moderation|babbage|davinci|search/;

export function chatModelsOnly(ids: string[]): string[] {
	return ids.filter((id) => !NOT_CHAT.test(id));
}
