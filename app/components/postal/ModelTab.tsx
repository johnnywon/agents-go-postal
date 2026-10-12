import { ArrowLeftIcon, ArrowSquareOutIcon, CheckIcon, KeyIcon, MagnifyingGlassIcon, WarningIcon } from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import api, { type ModelCatalog } from "~/services/api";
import {
	type CatalogModel, guessProvider, type KeyedProvider, makerOf, type ModelRef, PROVIDER_INFO, PROVIDERS,
	type ProviderId, sameModel, validModelId,
} from "shared/models";
import { Segmented } from "./Segmented";

export function useModelCatalog(enabled = true) {
	return useQuery({ queryKey: ["agent-model", "catalog"], queryFn: api.getModelCatalog, enabled, staleTime: 3_600_000 });
}

/** "Anthropic, Claude Sonnet 5.5", from the catalog when it has the model. */
export function modelName(catalog: ModelCatalog | undefined, ref: ModelRef): string {
	const found = catalog?.providers[ref.provider]?.models.find((m) => m.id === ref.id);
	return `${PROVIDER_INFO[ref.provider].label}, ${found?.name ?? ref.id}`;
}

/** Key edits: a string replaces the saved key, "" removes it. */
type KeyEdits = Partial<Record<KeyedProvider, string>>;

export function useAgentModelDraft() {
	const queryClient = useQueryClient();
	const { data: stored } = useQuery({ queryKey: ["agent-model"], queryFn: api.getAgentModel });
	// undefined: untouched. null: follow the recommended model.
	const [selected, setSelected] = useState<ModelRef | null | undefined>(undefined);
	const [keys, setKeys] = useState<KeyEdits>({});
	const current = selected === undefined ? stored?.selected ?? null : selected;
	const effective = current ?? stored?.recommended ?? null;
	const keyEdited = Object.values(keys).some((v) => v !== undefined);
	const selectionChanged = !!stored && selected !== undefined && !(
		(selected === null && stored.selected === null) || (selected && stored.selected && sameModel(selected, stored.selected))
	);
	const dirty = !!stored && (selectionChanged || keyEdited);
	/** Whether a provider has a key, counting unsaved edits. */
	const hasKey = (p: ProviderId) => p === "workers-ai" || (keys[p as KeyedProvider] !== undefined ? keys[p as KeyedProvider] !== "" : !!stored?.keys[p as KeyedProvider]?.set);
	const save = async () => {
		const view = await api.updateAgentModel({
			...(selectionChanged ? { selected: current } : {}),
			...(keyEdited ? { keys: Object.fromEntries(Object.entries(keys).map(([p, v]) => [p, v.trim()])) } : {}),
		});
		queryClient.setQueryData(["agent-model"], view);
		if (keyEdited) queryClient.invalidateQueries({ queryKey: ["agent-model", "catalog"] });
		setSelected(undefined);
		setKeys({});
	};
	return {
		stored, selected: current, effective, keys, dirty, hasKey, save,
		select: (ref: ModelRef) => setSelected(stored && sameModel(ref, stored.recommended) ? null : ref),
		setKey: (p: KeyedProvider, value: string | undefined) => setKeys((k) => ({ ...k, [p]: value })),
	};
}

type AgentModelDraft = ReturnType<typeof useAgentModelDraft>;

function formatContext(tokens: number | null): string {
	if (!tokens) return "–";
	if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`.replace(".0M", "M");
	return `${Math.round(tokens / 1000)}K`;
}

function formatPrice(usd: number): string {
	return usd >= 10 ? `$${usd.toFixed(0)}` : `$${usd.toFixed(2)}`;
}

/** Cost band by output price, which dominates an agent's bill. */
function priceTier(model: CatalogModel): "low" | "mid" | "high" | "none" {
	if (!model.price) return "none";
	return model.price.output <= 0.6 ? "low" : model.price.output <= 2 ? "mid" : "high";
}

/** Context on a log scale from 8K to 2M tokens, as a share of the bar. */
function contextShare(tokens: number | null): number {
	if (!tokens) return 0;
	const lo = Math.log(8_000), hi = Math.log(2_097_152);
	return Math.min(1, Math.max(0.04, (Math.log(tokens) - lo) / (hi - lo)));
}

function hueStyle(hue: number) {
	return { "--pg-h": hue } as React.CSSProperties;
}

function ProviderTag({ provider }: { provider: ProviderId }) {
	const info = PROVIDER_INFO[provider];
	return <span className="pg-prov" style={hueStyle(info.hue)}>{info.label}</span>;
}

function ModelRow({ model, selected, recommended, needsKey, onSelect }: {
	model: CatalogModel; selected: boolean; recommended: boolean; needsKey: boolean; onSelect: () => void;
}) {
	const maker = makerOf(model);
	const tier = priceTier(model);
	const showMaker = maker.label !== PROVIDER_INFO[model.provider].label;
	return (
		<button type="button" role="radio" aria-checked={selected} className="pg-model-row" onClick={onSelect}>
			<span className="pg-model-check" aria-hidden="true">{selected && <CheckIcon size={12} weight="bold" />}</span>
			<span className="pg-model-name">
				<span className="pg-model-title">
					<ProviderTag provider={model.provider} />
					{showMaker && <span className="pg-maker" style={hueStyle(maker.hue)}>{maker.label}</span>}
					<b>{model.name}</b>
					{recommended && <span className="pg-model-rec">Recommended</span>}
					{model.tools === false && <span className="pg-model-flag" title="The catalog doesn't list tool calling. The agent reads, labels and drafts through tools.">No tools</span>}
					{needsKey && <span className="pg-model-key" title={`Needs a ${PROVIDER_INFO[model.provider].label} key`}><KeyIcon size={11} /></span>}
				</span>
				<code>{model.id}</code>
			</span>
			<span className="pg-model-ctx">
				<span className="pg-model-bar" aria-hidden="true"><i style={{ width: `${contextShare(model.context) * 100}%` }} /></span>
				<span>{formatContext(model.context)}</span>
			</span>
			<span className="pg-model-price" data-tier={tier}>
				{model.price ? <><span>{formatPrice(model.price.input)}</span><span className="pg-model-slash">/</span><b>{formatPrice(model.price.output)}</b></> : "No price"}
			</span>
		</button>
	);
}

function PriceChip({ model }: { model: CatalogModel }) {
	return (
		<span className="pg-model-price" data-tier={priceTier(model)}>
			{model.price ? <><span>{formatPrice(model.price.input)}</span><span className="pg-model-slash">/</span><b>{formatPrice(model.price.output)}</b></> : "No price"}
		</span>
	);
}

/** One provider: whether it's connected, and its key when opened. */
function ProviderRow({ provider, draft, count, open, highlight, onToggle }: {
	provider: ProviderId; draft: AgentModelDraft; count: number; open: boolean; highlight: boolean; onToggle: () => void;
}) {
	const info = PROVIDER_INFO[provider];
	const keyed = provider !== "workers-ai";
	const saved = keyed ? draft.stored?.keys[provider as KeyedProvider] : undefined;
	const edit = keyed ? draft.keys[provider as KeyedProvider] : undefined;
	const removing = edit === "";
	const pendingKey = !!edit;
	const connected = !keyed || (pendingKey || (!!saved?.set && !removing));
	const status = !keyed ? "Built in"
		: removing ? "Removed on save"
		: pendingKey ? "New key, saves with Save changes"
		: saved?.set ? `Connected ····${saved.hint}`
		: "Not connected";
	return (
		<div className="pg-prov-row" data-open={open} data-highlight={highlight}>
			<div className="pg-prov-row-head">
				<i className="pg-prov-dot" data-on={connected} style={hueStyle(info.hue)} aria-hidden="true" />
				<b>{info.label}</b>
				<span className="pg-prov-status" data-on={connected}>{status}</span>
				<span className="pg-prov-count">{count} models</span>
				{keyed && (
					<button type="button" className="pg-btn pg-btn-sm" onClick={onToggle} aria-expanded={open}>
						{open ? "Done" : saved?.set || pendingKey ? "Manage" : "Add key"}
					</button>
				)}
			</div>
			{keyed && open && (
				<div className="pg-prov-row-key">
					<input
						className="pg-input pg-mono"
						type="password"
						autoComplete="off"
						spellCheck={false}
						autoFocus
						value={edit ?? ""}
						placeholder={saved?.set && !removing ? `Replace ····${saved.hint}` : info.keyHint ?? ""}
						aria-label={`${info.label} API key`}
						onChange={(e) => draft.setKey(provider as KeyedProvider, e.target.value || undefined)}
					/>
					{saved?.set && !removing && <button type="button" className="pg-btn pg-btn-sm pg-btn-quiet" onClick={() => draft.setKey(provider as KeyedProvider, "")}>Remove</button>}
					{removing && <button type="button" className="pg-btn pg-btn-sm pg-btn-quiet" onClick={() => draft.setKey(provider as KeyedProvider, undefined)}>Undo</button>}
					{info.keyUrl && <a className="pg-btn pg-btn-sm pg-btn-quiet" href={info.keyUrl} target="_blank" rel="noreferrer">Get a key <ArrowSquareOutIcon size={12} /></a>}
				</div>
			)}
		</div>
	);
}

type Filter = "all" | ProviderId;
type ModelSort = "suggested" | "price" | "context";
const GROUP_PREVIEW = 6;
const SEARCH_LIMIT = 150;

/** Step 2: the full list, opened from Change model. Picking a model returns to the overview. */
function ModelPicker({ catalog, draft, onPick, onBack }: {
	catalog: ModelCatalog; draft: AgentModelDraft; onPick: (ref: ModelRef) => void; onBack: () => void;
}) {
	const [query, setQuery] = useState("");
	const [filter, setFilter] = useState<Filter>("all");
	const [sort, setSort] = useState<ModelSort>("suggested");
	const [open, setOpen] = useState<Set<ProviderId>>(new Set());
	const [customProvider, setCustomProvider] = useState<ProviderId | null>(null);

	const all = PROVIDERS.flatMap((p) => catalog.providers[p]?.models ?? []);
	const recommended = catalog.recommended;
	const effective = draft.effective ?? recommended;
	const isSuggested = (m: ModelRef) => catalog.suggested.some((s) => sameModel(s, m));
	const find = (ref: ModelRef) => catalog.providers[ref.provider]?.models.find((m) => m.id === ref.id);

	const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
	const pool = filter === "all" ? all : catalog.providers[filter]?.models ?? [];
	const matches = pool.filter((m) => {
		if (!words.length) return true;
		const text = `${m.name} ${m.id} ${PROVIDER_INFO[m.provider].label} ${makerOf(m).label}`.toLowerCase();
		return words.every((w) => text.includes(w));
	});
	const sorter = sort === "price"
		? (a: CatalogModel, b: CatalogModel) => (a.price?.output ?? Infinity) - (b.price?.output ?? Infinity) || (a.price?.input ?? 0) - (b.price?.input ?? 0)
		: sort === "context"
			? (a: CatalogModel, b: CatalogModel) => (b.context ?? 0) - (a.context ?? 0) || (a.price?.output ?? Infinity) - (b.price?.output ?? Infinity)
			: (a: CatalogModel, b: CatalogModel) => Number(isSuggested(b)) - Number(isSuggested(a));
	const sorted = [...matches].sort(sorter);

	const grouped = filter === "all" && sort === "suggested" && words.length === 0;
	const suggestedRows = catalog.suggested.map(find).filter((m): m is CatalogModel => !!m);
	type Group = { key: string; title: React.ReactNode; count: number; rows: CatalogModel[]; more?: ProviderId; error?: string };
	const groups: Group[] = grouped
		? [
			{ key: "suggested", title: "Suggested", count: suggestedRows.length, rows: suggestedRows },
			...PROVIDERS.map((p) => {
				const pc = catalog.providers[p];
				const rows = pc?.models ?? [];
				const expanded = open.has(p);
				return {
					key: p, title: <><ProviderTag provider={p} />{pc?.source === "openrouter" && <span className="pg-models-src">via OpenRouter</span>}</>,
					count: rows.length, rows: expanded ? rows : rows.slice(0, GROUP_PREVIEW), more: !expanded && rows.length > GROUP_PREVIEW ? p : undefined, error: pc?.error,
				};
			}),
		]
		: [{ key: "results", title: `${sorted.length} ${sorted.length === 1 ? "model" : "models"}`, count: sorted.length, rows: sorted.slice(0, SEARCH_LIMIT) }];

	const typed = query.trim();
	const customTarget = customProvider ?? (filter === "all" ? guessProvider(typed) : filter);
	const showCustom = typed.length > 1 && !all.some((m) => m.id === typed) && !/\s/.test(typed);
	const customValid = validModelId(customTarget, typed);

	return (
		<div
			className="pg-picker"
			data-own-escape
			onKeyDown={(e) => {
				if (e.key !== "Escape") return;
				e.preventDefault();
				if (query) setQuery("");
				else onBack();
			}}
		>
			<div className="pg-picker-head">
				<button type="button" className="pg-btn pg-btn-sm pg-btn-quiet" onClick={onBack}><ArrowLeftIcon size={13} /> Back</button>
				<b>Choose a model</b>
				<span className="pg-models-legend">
					$ per 1M tokens, in / out
					<span data-tier="low">Low</span><span data-tier="mid">Mid</span><span data-tier="high">High</span>
				</span>
			</div>
			<div className="pg-models-tools">
				<label className="pg-models-search">
					<MagnifyingGlassIcon size={14} aria-hidden="true" />
					<input
						type="search"
						autoFocus
						value={query}
						placeholder="Search, or paste any model id"
						aria-label="Search models"
						spellCheck={false}
						onChange={(e) => { setQuery(e.target.value); setCustomProvider(null); }}
					/>
				</label>
				<Segmented<ModelSort>
					label="Sort models"
					value={sort}
					onChange={setSort}
					options={[{ value: "suggested", label: "Suggested" }, { value: "price", label: "Cheapest" }, { value: "context", label: "Most context" }]}
				/>
			</div>
			<div className="pg-prov-filter" role="group" aria-label="Provider">
				<button type="button" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>All <span>{all.length}</span></button>
				{PROVIDERS.map((p) => (
					<button key={p} type="button" aria-pressed={filter === p} onClick={() => setFilter(p)} style={hueStyle(PROVIDER_INFO[p].hue)}>
						<i aria-hidden="true" />{PROVIDER_INFO[p].label} <span>{catalog.providers[p]?.models.length ?? 0}</span>
					</button>
				))}
			</div>

			<div className="pg-models-list" role="radiogroup" aria-label="Agent model">
				{showCustom && (
					<div className="pg-models-group">
						<div className="pg-model-custom">
							<button type="button" role="radio" aria-checked={false} className="pg-model-row" disabled={!customValid} onClick={() => onPick({ provider: customTarget, id: typed })}>
								<span className="pg-model-check is-custom" aria-hidden="true" />
								<span className="pg-model-name">
									<span className="pg-model-title"><b>Use <code>{typed}</code></b></span>
									<code>{customValid ? `Sent to ${PROVIDER_INFO[customTarget].label} as typed` : `${PROVIDER_INFO[customTarget].label} ids look like ${PROVIDER_INFO[customTarget].idExample}`}</code>
								</span>
							</button>
							<select className="pg-select" value={customTarget} aria-label="Provider for this model id" onChange={(e) => setCustomProvider(e.target.value as ProviderId)}>
								{PROVIDERS.map((p) => <option key={p} value={p}>{PROVIDER_INFO[p].label}</option>)}
							</select>
						</div>
					</div>
				)}
				{groups.map((g) => (g.rows.length > 0 || g.error) && (
					<div key={g.key} className="pg-models-group">
						<div className="pg-models-group-head">
							<span>{g.title}</span>
							<span>{g.count}</span>
						</div>
						{g.error && <p className="pg-models-warn">{g.error}</p>}
						{g.rows.map((m) => (
							<ModelRow
								key={`${m.provider}:${m.id}`}
								model={m}
								selected={sameModel(m, effective)}
								recommended={sameModel(m, recommended)}
								needsKey={!draft.hasKey(m.provider)}
								onSelect={() => onPick({ provider: m.provider, id: m.id })}
							/>
						))}
						{g.more && (
							<button type="button" className="pg-models-more" onClick={() => setOpen(new Set(open).add(g.more!))}>
								Show all {g.count}
							</button>
						)}
					</div>
				))}
				{!grouped && sorted.length > SEARCH_LIMIT && <p className="pg-models-empty">{sorted.length - SEARCH_LIMIT} more. Narrow the search.</p>}
				{!grouped && sorted.length === 0 && !showCustom && <p className="pg-models-empty">No model matches "{typed}".</p>}
			</div>
		</div>
	);
}

/** Step 1: the model in use and the providers. "Change model" opens the picker. */
export function AgentModelSection({ draft }: { draft: AgentModelDraft }) {
	const { data: catalog, isLoading } = useModelCatalog();
	const [picking, setPicking] = useState(false);
	const [openKey, setOpenKey] = useState<ProviderId | null>(null);
	const [test, setTest] = useState<{ busy: boolean; ok?: boolean; text?: string }>({ busy: false });
	if (isLoading || !catalog || !draft.stored) return <p className="pg-table-note">Loading…</p>;

	const recommended = catalog.recommended;
	const effective = draft.effective ?? recommended;
	const model: CatalogModel = catalog.providers[effective.provider]?.models.find((m) => m.id === effective.id)
		?? { ...effective, name: effective.id, context: null, price: null, tools: null };
	const needsKey = !draft.hasKey(effective.provider);
	const maker = makerOf(model);

	if (picking) {
		return (
			<ModelPicker
				catalog={catalog}
				draft={draft}
				onBack={() => setPicking(false)}
				onPick={(ref) => {
					draft.select(ref);
					setPicking(false);
					setTest({ busy: false });
					if (!draft.hasKey(ref.provider)) setOpenKey(ref.provider);
				}}
			/>
		);
	}

	const runTest = async () => {
		setTest({ busy: true });
		try {
			const key = effective.provider === "workers-ai" ? undefined : draft.keys[effective.provider as KeyedProvider] || undefined;
			const r = await api.testAgentModel({ provider: effective.provider, id: effective.id, key });
			setTest({ busy: false, ok: r.ok, text: r.ok ? `Replied "${r.reply || "(empty)"}" in ${((r.ms ?? 0) / 1000).toFixed(1)} s` : r.error });
		} catch (e) {
			setTest({ busy: false, ok: false, text: (e as Error).message });
		}
	};

	return (
		<div className="pg-models">
			<div className="pg-models-head"><b>Agent model</b></div>
			<div className="pg-model-card">
				<div className="pg-model-card-main">
					<span className="pg-model-title">
						<ProviderTag provider={effective.provider} />
						{maker.label !== PROVIDER_INFO[effective.provider].label && <span className="pg-maker" style={hueStyle(maker.hue)}>{maker.label}</span>}
						{sameModel(effective, recommended) && <span className="pg-model-rec">Recommended</span>}
					</span>
					<b className="pg-model-card-name">{model.name}</b>
					<code>{effective.id}</code>
				</div>
				<dl className="pg-model-card-stats">
					<div><dt>Price</dt><dd><PriceChip model={model} /></dd></div>
					<div><dt>Context</dt><dd>{formatContext(model.context)}</dd></div>
				</dl>
				<div className="pg-model-card-actions">
					<button type="button" className="pg-btn pg-btn-sm" onClick={runTest} disabled={test.busy || needsKey}>{test.busy ? "Testing…" : "Test"}</button>
					<button type="button" className="pg-btn pg-btn-sm pg-btn-primary" onClick={() => setPicking(true)}>Change model</button>
				</div>
				{(needsKey || test.text) && (
					<p className="pg-model-current-msg" data-ok={needsKey ? "false" : String(!!test.ok)} role="status">
						{needsKey
							? <><WarningIcon size={12} /> Add your {PROVIDER_INFO[effective.provider].label} key below, or this model won't run.</>
							: test.text}
					</p>
				)}
			</div>

			<div className="pg-models-head"><b>Providers</b></div>
			<div className="pg-prov-list">
				{PROVIDERS.map((p) => (
					<ProviderRow
						key={p}
						provider={p}
						draft={draft}
						count={catalog.providers[p]?.models.length ?? 0}
						open={openKey === p}
						highlight={needsKey && effective.provider === p}
						onToggle={() => setOpenKey(openKey === p ? null : p)}
					/>
				))}
			</div>
		</div>
	);
}
