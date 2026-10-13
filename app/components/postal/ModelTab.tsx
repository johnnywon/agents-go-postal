import { ArrowLeftIcon, ArrowSquareOutIcon, CaretRightIcon, CheckIcon, MagnifyingGlassIcon, ShieldCheckIcon, WarningIcon } from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import api, { type ModelCatalog } from "~/services/api";
import {
	type CatalogModel, guessProvider, type KeyedProvider, makerOf, type ModelRef, PROVIDER_INFO, PROVIDERS,
	type ProviderId, sameModel, validModelId,
} from "shared/models";

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

function hueStyle(hue: number) {
	return { "--pg-h": hue } as React.CSSProperties;
}

/** The provider's colour square and name. The only place a provider's hue shows. */
function ProviderMark({ provider }: { provider: ProviderId }) {
	const info = PROVIDER_INFO[provider];
	return <span className="pg-prov-mark" style={hueStyle(info.hue)}><i aria-hidden="true" />{info.label}</span>;
}

/** What happens to prompts on a provider, linked to the provider's own policy. */
function DataLine({ provider, className }: { provider: ProviderId; className: string }) {
	const info = PROVIDER_INFO[provider];
	return (
		<span className={className} data-zdr={info.zdr}>
			{info.zdr && <ShieldCheckIcon size={13} aria-hidden="true" />}
			{info.data}{" "}
			<a href={info.policyUrl} target="_blank" rel="noreferrer">Policy<ArrowSquareOutIcon size={11} aria-hidden="true" /></a>
		</span>
	);
}

function Price({ model }: { model: CatalogModel }) {
	if (!model.price) return <span className="pg-model-price" data-none>–</span>;
	if (model.price.input === 0 && model.price.output === 0) return <span className="pg-model-price"><b>Free</b></span>;
	return (
		<span className="pg-model-price">
			{formatPrice(model.price.input)}<span className="pg-model-slash">/</span><b>{formatPrice(model.price.output)}</b>
		</span>
	);
}

/** Provider, maker when it differs, and what the model is missing. */
function ModelSub({ model, needsKey, provider = true, maker: showMakerLine = true }: { model: CatalogModel; needsKey: boolean; provider?: boolean; maker?: boolean }) {
	const maker = makerOf(model);
	const showMaker = maker.label !== PROVIDER_INFO[model.provider].label;
	return (
		<span className="pg-model-sub">
			{provider && <ProviderMark provider={model.provider} />}
			{showMakerLine && (showMaker || !provider) && <span>{maker.label}</span>}
			{model.tools === false && <span>No tools</span>}
			{needsKey && <span className="pg-model-needs">Needs key</span>}
		</span>
	);
}

function ModelRow({ model, selected, recommended, needsKey, provider, maker = true, onSelect }: {
	model: CatalogModel; selected: boolean; recommended: boolean; needsKey: boolean; provider: boolean; maker?: boolean; onSelect: () => void;
}) {
	return (
		<button type="button" role="radio" aria-checked={selected} className="pg-model-row" onClick={onSelect} title={model.id}>
			<span className="pg-model-check" aria-hidden="true">{selected && <CheckIcon size={12} weight="bold" />}</span>
			<span className="pg-model-name">
				<span className="pg-model-title"><b>{model.name}</b>{recommended && <span className="pg-model-rec">Recommended</span>}</span>
				<ModelSub model={model} needsKey={needsKey} provider={provider} maker={maker} />
			</span>
			<span className="pg-model-ctx">{formatContext(model.context)}</span>
			<Price model={model} />
		</button>
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
				<DataLine provider={provider} className="pg-prov-data" />
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

/** Makers whose models are reached through OpenRouter's zero retention endpoints, as shortcuts. */
const MAKER_FILTERS = ["Anthropic", "OpenAI", "Google", "xAI"] as const;
type MakerFilter = (typeof MAKER_FILTERS)[number];
type Filter = "all" | ProviderId | MakerFilter;
const isMaker = (f: Filter): f is MakerFilter => (MAKER_FILTERS as readonly string[]).includes(f);
/** The provider a filter's models come from. */
const providerOf = (f: Exclude<Filter, "all">): ProviderId => (isMaker(f) ? "openrouter" : f);
type ModelSort = "suggested" | "price" | "context";
const PAGE = 100;

/** Step 2: the full list, opened from Change model. Picking a model returns to the overview. */
function ModelPicker({ catalog, draft, onPick, onBack }: {
	catalog: ModelCatalog; draft: AgentModelDraft; onPick: (ref: ModelRef) => void; onBack: () => void;
}) {
	const [query, setQuery] = useState("");
	const [filter, setFilterState] = useState<Filter>("all");
	const [sort, setSort] = useState<ModelSort>("suggested");
	const [limit, setLimit] = useState(PAGE);
	const [customProvider, setCustomProvider] = useState<ProviderId | null>(null);
	const top = useRef<HTMLDivElement>(null);
	const setFilter = (f: Filter) => {
		setFilterState(f);
		setLimit(PAGE);
		top.current?.scrollIntoView({ block: "start" });
	};

	const all = PROVIDERS.flatMap((p) => catalog.providers[p]?.models ?? []);
	const recommended = catalog.recommended;
	const effective = draft.effective ?? recommended;
	const isSuggested = (m: ModelRef) => catalog.suggested.some((s) => sameModel(s, m));
	const find = (ref: ModelRef) => catalog.providers[ref.provider]?.models.find((m) => m.id === ref.id);

	const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
	const pool = filter === "all" ? all
		: isMaker(filter) ? (catalog.providers.openrouter?.models ?? []).filter((m) => makerOf(m).label === filter)
		: catalog.providers[filter]?.models ?? [];
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

	// Nothing typed and no provider chosen: one card per need, then one row per provider to browse.
	const home = filter === "all" && words.length === 0;
	const picks = catalog.suggested.flatMap((s) => {
		const m = find(s);
		return m ? [{ ...s, model: m }] : [];
	});
	const rows = home ? [] : [...matches].sort(sorter);
	const title = filter !== "all" && !words.length ? (isMaker(filter) ? `${filter} on OpenRouter` : <ProviderMark provider={filter} />)
		: `${rows.length} ${rows.length === 1 ? "match" : "matches"}`;
	const source = filter === "all" ? null : providerOf(filter);
	const error = source ? catalog.providers[source]?.error : undefined;
	// One provider's list says once that its key is missing, not on every row.
	const single = !!source;
	const missingKey = !!source && !draft.hasKey(source);

	const typed = query.trim();
	const customTarget = customProvider ?? (source ?? guessProvider(typed));
	const showCustom = typed.length > 1 && !all.some((m) => m.id === typed) && !/\s/.test(typed);
	const customValid = validModelId(customTarget, typed);

	return (
		<div
			ref={top}
			className="pg-picker"
			data-own-escape
			onKeyDown={(e) => {
				if (e.key !== "Escape") return;
				e.preventDefault();
				if (query) setQuery("");
				else if (filter !== "all") setFilter("all");
				else onBack();
			}}
		>
			<div className="pg-picker-head">
				<button type="button" className="pg-btn pg-btn-sm pg-btn-quiet" onClick={onBack}><ArrowLeftIcon size={13} /> Back</button>
				<b>Choose a model</b>
			</div>
			<label className="pg-models-search">
				<MagnifyingGlassIcon size={15} aria-hidden="true" />
				<input
					type="search"
					autoFocus
					value={query}
					placeholder={`Search ${all.length} models, or paste a model id`}
					aria-label="Search models"
					spellCheck={false}
					onChange={(e) => { setQuery(e.target.value); setCustomProvider(null); setLimit(PAGE); }}
				/>
			</label>
			<div className="pg-models-tools">
				<div className="pg-prov-filter" role="radiogroup" aria-label="Provider">
					<button type="button" role="radio" aria-checked={filter === "all"} onClick={() => setFilter("all")}>All</button>
					{PROVIDERS.map((p) => (
						<button key={p} type="button" role="radio" aria-checked={filter === p} onClick={() => setFilter(p)}>
							<ProviderMark provider={p} />
						</button>
					))}
					{MAKER_FILTERS.map((f) => (
						<button key={f} type="button" role="radio" aria-checked={filter === f} onClick={() => setFilter(f)}>{f}</button>
					))}
				</div>
				{!home && <select className="pg-select" value={sort} aria-label="Sort models" onChange={(e) => setSort(e.target.value as ModelSort)}>
					<option value="suggested">Suggested first</option>
					<option value="price">Cheapest first</option>
					<option value="context">Most context first</option>
				</select>}
			</div>

			{showCustom && (
				<div className="pg-model-custom">
					<button type="button" className="pg-model-row" disabled={!customValid} onClick={() => onPick({ provider: customTarget, id: typed })}>
						<span className="pg-model-check is-custom" aria-hidden="true" />
						<span className="pg-model-name">
							<span className="pg-model-title"><b>Use <code>{typed}</code></b></span>
							<span className="pg-model-sub">{customValid ? `Sent to ${PROVIDER_INFO[customTarget].label} as typed`
								: typed.endsWith(":free") ? "Free models aren't offered. Free endpoints can keep and train on prompts."
								: `${PROVIDER_INFO[customTarget].label} ids look like ${PROVIDER_INFO[customTarget].idExample}`}</span>
						</span>
					</button>
					<select className="pg-select" value={customTarget} aria-label="Provider for this model id" onChange={(e) => setCustomProvider(e.target.value as ProviderId)}>
						{PROVIDERS.map((p) => <option key={p} value={p}>{PROVIDER_INFO[p].label}</option>)}
					</select>
				</div>
			)}

			{home && (
				<p className="pg-picks-why">Picked for reliable tool calling, multi-step tasks and long threads. The agent chains searches, reads and drafts, and must ignore instructions written into the mail it reads. Heavy reasoning isn't needed and adds seconds to each reply.</p>
			)}
			{home && (
				<div className="pg-picks" role="radiogroup" aria-label="Suggested models">
					{picks.map(({ role, model: m }) => {
						const selected = sameModel(m, effective);
						return (
							<button
								key={`${m.provider}:${m.id}`}
								type="button"
								role="radio"
								aria-checked={selected}
								className="pg-pick"
								data-recommended={sameModel(m, recommended)}
								title={m.id}
								onClick={() => onPick({ provider: m.provider, id: m.id })}
							>
								<span className="pg-pick-role">
									{role}
									{PROVIDER_INFO[m.provider].zdr && <span className="pg-zdr"><ShieldCheckIcon size={12} /> Zero retention</span>}
									{selected && <CheckIcon size={13} weight="bold" />}
								</span>
								<b>{m.name}</b>
								<ModelSub model={m} needsKey={!draft.hasKey(m.provider)} />
								<span className="pg-pick-stats">
									<span>{formatContext(m.context)} <i>context</i></span>
									<span><Price model={m} /> <i>per 1M</i></span>
								</span>
							</button>
						);
					})}
				</div>
			)}

			{!home && (rows.length > 0 || !showCustom) && (
				<div className="pg-models-list" role="radiogroup" aria-label="Agent model">
					<div className="pg-models-cols">
						<span>{title}</span>
						<span>Context</span>
						<span>$ per 1M, in / out</span>
					</div>
					{error && <p className="pg-models-warn">{error}</p>}
					{source && !words.length && <DataLine provider={source} className="pg-models-note" />}
					{missingKey && source && <p className="pg-models-warn">No {PROVIDER_INFO[source].label} key yet. Pick a model, then add the key.</p>}
					{rows.slice(0, limit).map((m) => (
						<ModelRow
							key={`${m.provider}:${m.id}`}
							model={m}
							selected={sameModel(m, effective)}
							recommended={sameModel(m, recommended)}
							needsKey={!single && !draft.hasKey(m.provider)}
							provider={!single}
							maker={!isMaker(filter)}
							onSelect={() => onPick({ provider: m.provider, id: m.id })}
						/>
					))}
					{rows.length > limit && (
						<button type="button" className="pg-models-more" onClick={() => setLimit(rows.length)}>Show all {rows.length}</button>
					)}
					{rows.length === 0 && <p className="pg-models-empty">No model matches "{typed}".</p>}
				</div>
			)}

			{home && (
				<div className="pg-models-list">
					<div className="pg-models-cols"><span>Browse</span></div>
					{PROVIDERS.map((p) => (
						<button key={p} type="button" className="pg-browse-row" onClick={() => setFilter(p)}>
							<ProviderMark provider={p} />
							<span className="pg-model-sub">
								{PROVIDER_INFO[p].zdr && <span className="pg-zdr"><ShieldCheckIcon size={12} /> Zero retention</span>}
								{!draft.hasKey(p) && <span className="pg-model-needs">Needs key</span>}
							</span>
							<span className="pg-browse-count">{catalog.providers[p]?.models.length ?? 0} models</span>
							<CaretRightIcon size={13} aria-hidden="true" />
						</button>
					))}
					{MAKER_FILTERS.map((f) => (
						<button key={f} type="button" className="pg-browse-row" onClick={() => setFilter(f)}>
							<span>{f}</span>
							<span className="pg-model-sub"><ProviderMark provider="openrouter" /></span>
							<span className="pg-browse-count">{(catalog.providers.openrouter?.models ?? []).filter((m) => makerOf(m).label === f).length} models</span>
							<CaretRightIcon size={13} aria-hidden="true" />
						</button>
					))}
				</div>
			)}
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
			<div className="pg-models-notice" role="note">
				<ShieldCheckIcon size={18} weight="duotone" aria-hidden="true" />
				<div>
					<b>No training on your mail. Zero retention on OpenRouter.</b>
					<p>
						The agent reads your mail, so a model that keeps or trains on it is a security risk. Cloudflare doesn't train
						on your prompts but makes no zero retention promise; your mailbox is already stored there
						(<a href={PROVIDER_INFO["workers-ai"].policyUrl} target="_blank" rel="noreferrer">policy</a>). OpenRouter is held
						to zero data retention endpoints and doesn't log prompts
						(<a href={PROVIDER_INFO.openrouter.policyUrl} target="_blank" rel="noreferrer">policy</a>). Free, unpriced and
						third-party partner models, and direct provider keys, can't be connected.
					</p>
				</div>
			</div>
			<div className="pg-models-head"><b>Agent model</b></div>
			<div className="pg-model-card">
				<div className="pg-model-card-main">
					<span className="pg-model-title">
						<b className="pg-model-card-name">{model.name}</b>
						{sameModel(effective, recommended) && <span className="pg-model-rec">Recommended</span>}
					</span>
					<ModelSub model={model} needsKey={false} />
					<code>{effective.id}</code>
					<DataLine provider={effective.provider} className="pg-model-data" />
				</div>
				<dl className="pg-model-card-stats">
					<div><dt>Context</dt><dd>{formatContext(model.context)}</dd></div>
					<div><dt>$ per 1M, in / out</dt><dd><Price model={model} /></dd></div>
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
