/**
 * The Workers AI models Settings > Model & key suggests for the agent.
 *
 * Prices and context sizes shown in Settings come from Cloudflare's catalog
 * (env.AI.models()) when it can be read. The numbers here are the fallback,
 * copied from that catalog on CATALOG_SNAPSHOT_DATE. To change the default,
 * move `recommended` to another entry; deployments that never picked a model
 * follow it.
 */

export interface WorkersAiPrice {
	/** USD per million input tokens. */
	input: number;
	/** USD per million output tokens. */
	output: number;
}

export interface WorkersAiModel {
	id: string;
	name: string;
	note: string;
	/** Tokens the model can take in at once. */
	context: number | null;
	price: WorkersAiPrice | null;
	recommended?: boolean;
	/** True for the short list above; false for the rest of the catalog. */
	suggested: boolean;
}

export const CATALOG_SNAPSHOT_DATE = "2026-10-12";

export const SUGGESTED_WORKERS_AI_MODELS: WorkersAiModel[] = [
	{
		id: "@cf/moonshotai/kimi-k2.6",
		name: "Kimi K2.6",
		note: "Reliable tool calls, and long threads fit. The default.",
		context: 262_144,
		price: { input: 0.95, output: 4 },
		recommended: true,
		suggested: true,
	},
	{
		id: "@cf/zai-org/glm-5.3",
		name: "GLM 5.3",
		note: "Strongest listed. Costs the most.",
		context: 1_048_576,
		price: { input: 1.4, output: 4.4 },
		suggested: true,
	},
	{
		id: "@cf/deepseek-ai/deepseek-v4-flash-0731",
		name: "DeepSeek V4 Flash",
		note: "Good quality for about a third of the price.",
		context: 1_048_576,
		price: { input: 0.44, output: 1.32 },
		suggested: true,
	},
	{
		id: "@cf/openai/gpt-oss-120b",
		name: "GPT-OSS 120B",
		note: "Cheap and steady with tools.",
		context: 128_000,
		price: { input: 0.35, output: 0.75 },
		suggested: true,
	},
	{
		id: "@cf/zai-org/glm-5.3-flash",
		name: "GLM 5.3 Flash",
		note: "Fastest and cheapest worth using.",
		context: 1_048_576,
		price: { input: 0.15, output: 0.5 },
		suggested: true,
	},
];

export const RECOMMENDED_WORKERS_AI_MODEL = SUGGESTED_WORKERS_AI_MODELS.find((m) => m.recommended)!.id;

/** One entry of Cloudflare's model catalog, as env.AI.models() returns it. */
export interface CatalogEntry {
	name: string;
	description?: string;
	task?: { name?: string };
	properties?: { property_id: string; value: unknown }[];
}

function priceOf(value: unknown): WorkersAiPrice | null {
	if (!Array.isArray(value)) return null;
	const find = (unit: string) => value.find((p) => p && typeof p === "object" && p.unit === unit && typeof p.price === "number")?.price as number | undefined;
	const input = find("per M input tokens");
	const output = find("per M output tokens");
	return input === undefined || output === undefined ? null : { input, output };
}

/** A readable name from a model id: "@cf/zai-org/glm-5.3-flash" becomes "glm-5.3-flash". */
function shortName(id: string): string {
	return id.split("/").pop() ?? id;
}

/**
 * The text models that can call tools, with the suggested ones first in their
 * listed order and the rest by name. Suggested models missing from the catalog
 * are dropped.
 */
export function modelsFromCatalog(catalog: CatalogEntry[]): WorkersAiModel[] {
	const tools = new Map<string, WorkersAiModel>();
	for (const entry of catalog) {
		if (entry.task?.name !== "Text Generation") continue;
		const props = new Map((entry.properties ?? []).map((p) => [p.property_id, p.value]));
		const fc = props.get("function_calling");
		if (fc !== true && fc !== "true") continue;
		const context = Number(props.get("context_window"));
		tools.set(entry.name, {
			id: entry.name,
			name: shortName(entry.name),
			note: "",
			context: Number.isFinite(context) && context > 0 ? context : null,
			price: priceOf(props.get("price")),
			suggested: false,
		});
	}
	const suggested = SUGGESTED_WORKERS_AI_MODELS.filter((m) => tools.has(m.id)).map((m) => {
		const live = tools.get(m.id)!;
		return { ...m, context: live.context ?? m.context, price: live.price ?? m.price };
	});
	const rest = [...tools.values()].filter((m) => !SUGGESTED_WORKERS_AI_MODELS.some((s) => s.id === m.id)).sort((a, b) => a.name.localeCompare(b.name));
	return [...suggested, ...rest];
}
