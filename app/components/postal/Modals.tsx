// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	ArrowCounterClockwiseIcon, AtIcon, CheckIcon, CopyIcon, DatabaseIcon, DesktopIcon, GearSixIcon, KeyboardIcon, MoonIcon,
	KeyIcon, MagnifyingGlassIcon, PlugsConnectedIcon, SignatureIcon, SignOutIcon, SlidersHorizontalIcon, SunIcon, TagIcon, WrenchIcon, XIcon,
} from "@phosphor-icons/react";
import { AgentIcon } from "./AgentIcon";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { queryKeys } from "~/queries/keys";
import api, { type AgentProvider, type WorkersAiModelList } from "~/services/api";
import { makerOf, type WorkersAiModel } from "shared/workers-ai-models";
import { type AddressInfo, textToParagraphs } from "./compose";
import { Editor } from "./Editor";
import { htmlToPlainText } from "~/lib/utils";
import { AddressText, type Identities, Swatch } from "./identity";
import { LabelsTab } from "./LabelsTab";
import type { SettingsTab } from "./settings-tabs";
import { StorageTab } from "./StorageTab";
import { type Prefs, usePrefs } from "./prefs";
import { samePrefs } from "shared/prefs";
import { Keys } from "./shortcuts";
import { ShortcutList } from "./ShortcutsTab";

function Modal({ className = "", label, onClose, children }: { className?: string; label: string; onClose: () => void; children: React.ReactNode }) {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const previous = document.activeElement as HTMLElement | null;
		ref.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				// Escape in a search box with text clears the box; the box handles it.
				if (e.target instanceof HTMLInputElement && e.target.type === "search" && e.target.value) return;
				e.preventDefault();
				onClose();
			} else if (e.key === "Tab" && ref.current) {
				const items = [...ref.current.querySelectorAll<HTMLElement>("button, input, textarea, select, a[href], [tabindex='0']")].filter((el) => !el.hasAttribute("disabled"));
				if (!items.length) return;
				const first = items[0];
				const last = items[items.length - 1];
				if (e.shiftKey && document.activeElement === first) {
					e.preventDefault();
					last.focus();
				} else if (!e.shiftKey && document.activeElement === last) {
					e.preventDefault();
					first.focus();
				}
			}
		};
		document.addEventListener("keydown", onKey, true);
		return () => {
			document.removeEventListener("keydown", onKey, true);
			previous?.focus?.();
		};
	}, []); // eslint-disable-line react-hooks/exhaustive-deps
	return (
		<div className="pg-modal-scrim" onClick={onClose}>
			<div ref={ref} className={`pg-modal ${className}`} role="dialog" aria-modal="true" aria-label={label} onClick={(e) => e.stopPropagation()}>
				{children}
			</div>
		</div>
	);
}

function Head({ icon, title, sub, onClose, danger }: { icon: React.ReactNode; title: string; sub: string; onClose: () => void; danger?: boolean }) {
	return (
		<div className="pg-modal-head">
			<span className={`pg-modal-icon${danger ? " is-danger" : ""}`}>{icon}</span>
			<div className="pg-modal-title">
				<h2>{title}</h2>
				<span>{sub}</span>
			</div>
			<button type="button" className="pg-modal-x" title="Close (Esc)" aria-label="Close" onClick={onClose}><XIcon size={16} /></button>
		</div>
	);
}

function Switch({ on, onChange, label }: { on: boolean; onChange: (on: boolean) => void; label: string }) {
	return (
		<button type="button" role="switch" aria-checked={on} aria-label={label} className="pg-switch" onClick={() => onChange(!on)}>
			<span />
		</button>
	);
}

function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string; icon?: React.ReactNode }[]; onChange: (v: T) => void; label: string }) {
	return (
		<div className="pg-segmented" role="group" aria-label={label}>
			{options.map((o) => (
				<button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
					{o.icon}{o.label}
				</button>
			))}
		</div>
	);
}

function Setting({ title, sub, children }: { title: string; sub?: React.ReactNode; children: React.ReactNode }) {
	return (
		<div className="pg-setting">
			<div className="pg-setting-text"><b>{title}</b>{sub && <span>{sub}</span>}</div>
			{children}
		</div>
	);
}

function useAgentModelDraft() {
	const queryClient = useQueryClient();
	const { data: stored } = useQuery({ queryKey: ["agent-model"], queryFn: api.getAgentModel });
	const [provider, setProvider] = useState<AgentProvider | null>(null);
	const [model, setModel] = useState<string | null>(null);
	const [key, setKey] = useState("");
	const [removeKey, setRemoveKey] = useState(false);
	const [workersAiModel, setWorkersAiModel] = useState<string | null>(null);
	const current = {
		provider: provider ?? stored?.provider ?? "workers-ai",
		model: model ?? stored?.model ?? "",
		workersAiModel: workersAiModel ?? stored?.workersAiModel ?? "",
	};
	const dirty = !!stored && (
		current.provider !== stored.provider || current.model.trim() !== stored.model || key.trim() !== "" || removeKey
		|| current.workersAiModel !== stored.workersAiModel
	);
	const save = async () => {
		const view = await api.updateAgentModel({
			provider: current.provider,
			model: current.model.trim(),
			apiKey: removeKey ? "" : key.trim() || undefined,
			workersAiModel: current.workersAiModel,
		});
		queryClient.setQueryData(["agent-model"], view);
	};
	return { stored, ...current, key, removeKey, dirty, save, setProvider, setModel, setKey, setRemoveKey, setWorkersAiModel };
}

type AgentModelDraft = ReturnType<typeof useAgentModelDraft>;

function useWorkersAiModels(enabled = true) {
	return useQuery({ queryKey: ["agent-model", "workers-ai"], queryFn: api.listWorkersAiModels, enabled, staleTime: 3_600_000 });
}

/** The display name of a Workers AI model id, from the list when it's there. */
function workersAiName(list: WorkersAiModelList | undefined, id: string): string {
	return list?.models.find((m) => m.id === id)?.name ?? id.split("/").pop() ?? id;
}

function formatContext(tokens: number | null): string {
	if (!tokens) return "–";
	return tokens >= 1_000_000 ? `${Math.round(tokens / 1_000_000)}M` : `${Math.round(tokens / 1000)}K`;
}

function formatPrice(usd: number | undefined): string {
	return usd === undefined ? "–" : `$${usd.toFixed(2)}`;
}

/** Cost band by output price, which dominates an agent's bill. */
function priceTier(model: WorkersAiModel): "low" | "mid" | "high" | "none" {
	if (!model.price) return "none";
	return model.price.output <= 0.6 ? "low" : model.price.output <= 2 ? "mid" : "high";
}

/** Context on a log scale from 8K to 1M tokens, as a share of the bar. */
function contextShare(tokens: number | null): number {
	if (!tokens) return 0;
	const lo = Math.log(8_000), hi = Math.log(1_048_576);
	return Math.min(1, Math.max(0.04, (Math.log(tokens) - lo) / (hi - lo)));
}

function WorkersAiRow({ model, selected, recommended, onSelect }: { model: WorkersAiModel; selected: boolean; recommended: boolean; onSelect: () => void }) {
	const maker = makerOf(model.id);
	const tier = priceTier(model);
	return (
		<button type="button" role="radio" aria-checked={selected} className="pg-model-row" onClick={onSelect}>
			<span className="pg-model-check" aria-hidden="true">{selected && <CheckIcon size={12} weight="bold" />}</span>
			<span className="pg-model-name">
				<span className="pg-model-title">
					<span className="pg-maker" style={{ "--pg-h": maker.hue } as React.CSSProperties}>{maker.label}</span>
					<b>{model.name}</b>
					{recommended && <span className="pg-model-rec">Recommended</span>}
				</span>
				<code>{model.id}</code>
			</span>
			<span className="pg-model-ctx" data-label="Context">
				<span className="pg-model-bar" aria-hidden="true"><i style={{ width: `${contextShare(model.context) * 100}%` }} /></span>
				<span>{formatContext(model.context)}</span>
			</span>
			<span className="pg-model-price" data-tier={tier}>
				{tier === "none" ? "No price" : <><span>{formatPrice(model.price?.input)}</span><span className="pg-model-slash">/</span><b>{formatPrice(model.price?.output)}</b></>}
			</span>
		</button>
	);
}

type ModelSort = "suggested" | "price" | "context";

function WorkersAiPicker({ draft }: { draft: AgentModelDraft }) {
	const { data: list, isLoading } = useWorkersAiModels();
	const [query, setQuery] = useState("");
	const [sort, setSort] = useState<ModelSort>("suggested");
	if (isLoading || !list) return <p className="pg-table-note">Loading…</p>;

	const recommended = list.recommended;
	const saved = draft.workersAiModel;
	const selected = saved || recommended;
	const savedMissing = !!saved && list.live && !list.models.some((m) => m.id === saved);
	const select = (id: string) => draft.setWorkersAiModel(id === recommended ? "" : id);

	const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
	const matches = list.models.filter((m) => {
		const text = `${m.name} ${m.id} ${makerOf(m.id).label}`.toLowerCase();
		return words.every((w) => text.includes(w));
	});
	const sorted = sort === "suggested" ? matches
		: [...matches].sort(sort === "price"
			? (a, b) => (a.price?.output ?? Infinity) - (b.price?.output ?? Infinity) || (a.price?.input ?? 0) - (b.price?.input ?? 0)
			: (a, b) => (b.context ?? 0) - (a.context ?? 0) || (a.price?.output ?? Infinity) - (b.price?.output ?? Infinity));
	const grouped = sort === "suggested" && words.length === 0;
	const groups = grouped
		? [{ title: "Suggested", rows: sorted.filter((m) => m.suggested) }, { title: "More from Cloudflare", rows: sorted.filter((m) => !m.suggested) }]
		: [{ title: `${sorted.length} ${sorted.length === 1 ? "model" : "models"}`, rows: sorted }];
	const row = (m: WorkersAiModel) => <WorkersAiRow key={m.id} model={m} selected={m.id === selected} recommended={m.id === recommended} onSelect={() => select(m.id)} />;

	return (
		<div className="pg-models">
			<div className="pg-models-head">
				<b>Agent model</b>
				<span className="pg-models-legend">
					$ per 1M tokens, in / out
					<span data-tier="low">Low</span><span data-tier="mid">Mid</span><span data-tier="high">High</span>
				</span>
			</div>
			{savedMissing && (
				<p className="pg-models-warn">
					Cloudflare no longer lists <code>{saved}</code>. The agent is using {workersAiName(list, recommended)} until you choose another model.
				</p>
			)}
			<div className="pg-models-tools">
				<label className="pg-models-search">
					<MagnifyingGlassIcon size={14} aria-hidden="true" />
					<input
						type="search"
						value={query}
						placeholder="Search models"
						aria-label="Search Workers AI models"
						spellCheck={false}
						onChange={(e) => setQuery(e.target.value)}
						onKeyDown={(e) => { if (e.key === "Escape" && query) { e.preventDefault(); setQuery(""); } }}
					/>
				</label>
				<Segmented<ModelSort>
					label="Sort models"
					value={sort}
					onChange={setSort}
					options={[{ value: "suggested", label: "Suggested" }, { value: "price", label: "Cheapest" }, { value: "context", label: "Most context" }]}
				/>
			</div>
			<div className="pg-models-list" role="radiogroup" aria-label="Workers AI model">
				{groups.map((g) => g.rows.length > 0 && (
					<div key={g.title} className="pg-models-group">
						<div className="pg-models-group-head">
							<span>{g.title}</span>
							{grouped && <span>{g.rows.length}</span>}
						</div>
						{g.rows.map(row)}
					</div>
				))}
				{sorted.length === 0 && <p className="pg-models-empty">No model matches "{query.trim()}".</p>}
			</div>
		</div>
	);
}

function AgentModelSection({ draft }: { draft: AgentModelDraft }) {
	const openrouter = draft.provider === "openrouter";
	const { data: models } = useQuery({ queryKey: ["agent-model", "models"], queryFn: api.listAgentModels, enabled: openrouter, staleTime: 3_600_000 });
	const [test, setTest] = useState<{ busy: boolean; result?: string; ok?: boolean }>({ busy: false });
	const keySaved = !!draft.stored?.keySet && !draft.removeKey;
	const hasKey = keySaved || draft.key.trim() !== "";

	const runTest = async () => {
		setTest({ busy: true });
		try {
			const r = await api.testAgentModel({ model: draft.model.trim() || undefined, apiKey: draft.key.trim() || undefined });
			setTest({ busy: false, ok: r.ok, result: r.ok ? `Replied: ${r.reply || "(empty)"}` : `OpenRouter: ${r.error}` });
		} catch (e) {
			setTest({ busy: false, ok: false, result: `OpenRouter: ${(e as Error).message}` });
		}
	};

	return (
		<>
			<Setting
				title="Provider"
				sub={openrouter
					? "Chat and auto-draft run on OpenRouter and bill your OpenRouter account. Safety checks on incoming mail stay on Workers AI."
					: null}
			>
				<Segmented<AgentProvider>
					label="Agent model provider"
					value={draft.provider}
					onChange={(v) => { draft.setProvider(v); setTest({ busy: false }); }}
					options={[{ value: "workers-ai", label: "Workers AI" }, { value: "openrouter", label: "OpenRouter" }]}
				/>
			</Setting>
			{!openrouter && <WorkersAiPicker draft={draft} />}
			{openrouter && (
				<>
					<Setting
						title="OpenRouter API key"
						sub={keySaved ? `Saved key ending ${draft.stored?.keyHint || "····"}. Paste a new one to replace it.` : "Stored on your Worker. The key is never sent back to the browser."}
					>
						<div className="pg-setting-field">
							<input
								className="pg-input pg-mono"
								type="password"
								autoComplete="off"
								spellCheck={false}
								value={draft.key}
								placeholder={keySaved ? "••••••••" : "sk-or-…"}
								aria-label="OpenRouter API key"
								onChange={(e) => { draft.setKey(e.target.value); draft.setRemoveKey(false); }}
							/>
							{keySaved && (
								<button type="button" className="pg-btn pg-btn-sm pg-btn-quiet" onClick={() => { draft.setRemoveKey(true); draft.setKey(""); }}>Remove</button>
							)}
						</div>
					</Setting>
					<Setting title="OpenRouter model" sub="Only models that can call tools are listed. The agent needs tools to read, label and draft.">
						<div className="pg-setting-field">
						<input
							className="pg-input pg-mono"
							list="pg-openrouter-models"
							value={draft.model}
							placeholder="provider/model"
							aria-label="OpenRouter model"
							spellCheck={false}
							onChange={(e) => draft.setModel(e.target.value)}
						/>
						</div>
						<datalist id="pg-openrouter-models">
							{models?.models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
						</datalist>
					</Setting>
					<div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0 10px" }}>
						<button type="button" className="pg-btn pg-btn-sm" onClick={runTest} disabled={test.busy || !hasKey || !draft.model.trim()}>
							{test.busy ? "Testing…" : "Test"}
						</button>
						{test.result && (
							<span role="status" style={{ fontSize: 12, color: test.ok ? "var(--pg-green-text)" : "var(--pg-danger)" }}>{test.result}</span>
						)}
					</div>
				</>
			)}
		</>
	);
}

export function SettingsModal({ tab, onTab, prefs, setPrefs, addresses, identities, info, autoDraft, onClose, onSaved }: {
	tab: SettingsTab;
	onTab: (tab: SettingsTab) => void;
	prefs: Prefs;
	setPrefs: (p: Partial<Prefs>) => Promise<unknown>;
	addresses: string[];
	identities: Identities;
	info: ReadonlyMap<string, AddressInfo>;
	autoDraft: boolean;
	onClose: () => void;
	onSaved: (message: string) => void;
}) {
	const initialSigs = Object.fromEntries(addresses.map((a) => {
		const sig = info.get(a)?.mailbox?.settings?.signature;
		const html = sig?.html || (sig?.text ? textToParagraphs(sig.text) : "");
		return [a, { html, enabled: !!sig?.enabled && !!html }];
	}));
	const [sigs, setSigs] = useState<Record<string, { html: string; enabled: boolean }>>(initialSigs);
	const sigChanged = (a: string) => (sigs[a]?.html ?? "") !== (initialSigs[a]?.html ?? "") || !!sigs[a]?.enabled !== !!initialSigs[a]?.enabled;
	const [draft, setDraft] = useState<Prefs>(prefs);
	const initialNames = Object.fromEntries(addresses.map((a) => [a, info.get(a)?.mailbox?.settings?.fromName ?? info.get(a)?.name ?? ""]));
	const [names, setNames] = useState<Record<string, string>>(initialNames);
	const initialPrompt = addresses.map((a) => info.get(a)?.mailbox?.settings?.agentSystemPrompt).find((p) => p?.trim()) ?? "";
	const [prompt, setPrompt] = useState(initialPrompt);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const queryClient = useQueryClient();
	const agentModel = useAgentModelDraft();
	const { data: workersAi } = useWorkersAiModels(tab === "agent");

	const dirty = !samePrefs(draft, prefs)
		|| addresses.some((a) => (names[a] ?? "") !== (initialNames[a] ?? ""))
		|| prompt.trim() !== initialPrompt.trim()
		|| addresses.some(sigChanged)
		|| agentModel.dirty;

	const save = async () => {
		setSaving(true);
		setError(null);
		try {
			const writes: Promise<unknown>[] = addresses.flatMap((a) => {
				const mailbox = info.get(a)?.mailbox;
				if (!mailbox) return [];
				const name = (names[a] ?? "").trim();
				const nameChanged = name !== (initialNames[a] ?? "").trim() && name.length > 0;
				const promptChanged = (mailbox.settings?.agentSystemPrompt ?? "").trim() !== prompt.trim();
				const signatureChanged = sigChanged(a);
				if (!nameChanged && !promptChanged && !signatureChanged) return [];
				const sig = sigs[a];
				const empty = !sig?.html.replace(/<[^>]+>/g, "").trim();
				const settings = {
					...mailbox.settings,
					...(nameChanged ? { fromName: name } : {}),
					agentSystemPrompt: prompt.trim() || undefined,
					...(signatureChanged ? { signature: empty ? { enabled: false, text: "" } : { enabled: sig.enabled, text: htmlToPlainText(sig.html), html: sig.html } } : {}),
				};
				return [api.updateMailbox(a, settings)];
			});
			if (!samePrefs(draft, prefs)) writes.push(setPrefs(draft));
			if (agentModel.dirty) writes.push(agentModel.save());
			await Promise.all(writes);
			for (const a of addresses) queryClient.invalidateQueries({ queryKey: queryKeys.mailboxes.detail(a) });
			onSaved("Settings saved");
			onClose();
		} catch (e) {
			setError((e as Error).message || "Could not save settings.");
		} finally {
			setSaving(false);
		}
	};

	const tabs: { id: SettingsTab; label: string; icon: React.ReactNode }[] = [
		{ id: "general", label: "General", icon: <SlidersHorizontalIcon size={16} /> },
		{ id: "addresses", label: "Addresses", icon: <AtIcon size={16} /> },
		{ id: "signatures", label: "Signatures", icon: <SignatureIcon size={16} /> },
		{ id: "labels", label: "Labels", icon: <TagIcon size={16} /> },
		{ id: "shortcuts", label: "Shortcuts", icon: <KeyboardIcon size={16} /> },
		{ id: "agent", label: "Agent", icon: <AgentIcon size={16} /> },
		{ id: "model", label: "Model & key", icon: <KeyIcon size={16} /> },
		{ id: "storage", label: "Storage", icon: <DatabaseIcon size={16} /> },
	];

	return (
		<Modal className="is-settings" label="Settings" onClose={onClose}>
			<Head icon={<GearSixIcon size={16} />} title="Settings" sub="Saved to your deployment" onClose={onClose} />
			<div className="pg-settings">
				<div className="pg-tabs" role="tablist" aria-label="Settings sections">
					{tabs.map((t) => (
						<button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => onTab(t.id)} ref={tab === t.id ? (el) => el?.scrollIntoView({ block: "nearest", inline: "nearest" }) : undefined}>{t.icon}<span>{t.label}</span></button>
					))}
				</div>
				<div className="pg-tab-body" role="tabpanel">
					{tab === "general" && (
						<>
							<Setting title="Theme" sub="Dark is the default. System follows your device.">
								<Segmented
									label="Theme"
									value={draft.theme}
									onChange={(theme) => setDraft({ ...draft, theme })}
									options={[
										{ value: "dark", label: "Dark", icon: <MoonIcon size={12} /> },
										{ value: "light", label: "Light", icon: <SunIcon size={12} /> },
										{ value: "system", label: "System", icon: <DesktopIcon size={12} /> },
									]}
								/>
							</Setting>
							<Setting title="Show key hints" sub="Keys like ⌘K and E next to buttons. Shortcuts work either way.">
								<Switch label="Show key hints" on={draft.keys} onChange={(keys) => setDraft({ ...draft, keys })} />
							</Setting>
							<Setting title="Mark as read when opened" sub="Otherwise mail stays unread until you mark it read or archive it.">
								<Switch label="Mark as read when opened" on={draft.markRead} onChange={(markRead) => setDraft({ ...draft, markRead })} />
							</Setting>
							<Setting title="Remote images" sub="Images in HTML email load from the sender’s server and can track opens.">
								<Segmented
									label="Remote images"
									value={draft.images}
									onChange={(images) => setDraft({ ...draft, images })}
									options={[{ value: "ask", label: "Ask" }, { value: "always", label: "Always" }, { value: "never", label: "Never" }]}
								/>
							</Setting>
							<Setting title="Reply from receiving address" sub="Replies go out from the address the mail was delivered to.">
								<Switch label="Reply from receiving address" on={draft.replyFrom} onChange={(replyFrom) => setDraft({ ...draft, replyFrom })} />
							</Setting>
						</>
					)}
					{tab === "addresses" && (
						<>
							<div className="pg-tab-intro">Display name shown to recipients, per address. Addresses come from <span className="pg-mono">EMAIL_ADDRESSES</span> in your Worker config.</div>
							{addresses.map((a) => {
								const id = identities.of(a);
								return (
									<div key={a} className="pg-addr-row">
										<Swatch identity={id} />
										<AddressText address={a} identity={id} bold={false} />
										<input className="pg-input" value={names[a] ?? ""} placeholder="Display name" aria-label={`Display name for ${a}`} onChange={(e) => setNames({ ...names, [a]: e.target.value })} disabled={!info.get(a)?.mailbox} />
									</div>
								);
							})}
						</>
					)}
					{tab === "signatures" && (
						<>
							<div className="pg-tab-intro">One signature per address. Nothing is added unless you turn it on; the signature button in the composer adds or removes it on any message.</div>
							{addresses.map((a) => {
								const id = identities.of(a);
								const sig = sigs[a] ?? { html: "", enabled: false };
								const has = !!sig.html.replace(/<[^>]+>/g, "").trim();
								return (
									<div key={a} className="pg-sig-row">
										<div className="pg-sig-head">
											<Swatch identity={id} />
											<span className="pg-flex pg-ellipsis" style={{ fontSize: 12 }}><AddressText address={a} identity={id} bold={false} /></span>
											<span className="pg-sig-default">Add by default</span>
											<Switch
												label={`Add the signature for ${a} by default`}
												on={sig.enabled && has}
												onChange={(enabled) => setSigs({ ...sigs, [a]: { ...sig, enabled: enabled && has } })}
											/>
										</div>
										<div className="pg-sig-editor">
											<Editor
												value={sig.html}
												onChange={(html) => setSigs((cur) => ({ ...cur, [a]: { html, enabled: cur[a]?.enabled ?? false } }))}
												placeholder="No signature"
												label={`Signature for ${a}`}
											/>
										</div>
									</div>
								);
							})}
						</>
					)}
					{tab === "agent" && (
						<>
							<div style={{ display: "flex", alignItems: "center", gap: 8, padding: "14px 0 8px" }}>
								<b style={{ fontWeight: 500 }}>Agent prompt</b>
								<span className="pg-badge">{prompt.trim() ? "Custom" : "Default"}</span>
								<div className="pg-flex" />
								{prompt.trim() && (
									<button type="button" className="pg-btn pg-btn-sm pg-btn-quiet" onClick={() => setPrompt("")}>
										<ArrowCounterClockwiseIcon size={12} />Reset to default
									</button>
								)}
							</div>
							<textarea
								className="pg-textarea"
								rows={9}
								value={prompt}
								aria-label="Agent prompt"
								onChange={(e) => setPrompt(e.target.value)}
								placeholder="You are an email assistant that helps manage this inbox. You read emails, draft replies, and help organize conversations. Write like a real person. Short, direct, flowing prose. Plain text only. (Leave empty to use the built-in default prompt)"
							/>
							<div style={{ fontSize: 12, color: "var(--pg-text-6)", padding: "6px 0 4px" }}>Sent as the system message for every address. Controls tone, style and behaviour rules.</div>
							<Setting title="Model" sub={agentModel.stored?.provider === "openrouter"
								? `OpenRouter, ${agentModel.stored.model}`
								: `Workers AI, ${workersAiName(workersAi, agentModel.stored?.workersAiModel || workersAi?.recommended || agentModel.stored?.defaultModel || "")}`}>
								<button type="button" className="pg-btn pg-btn-sm" onClick={() => onTab("model")}>Change</button>
							</Setting>
							<Setting title="Auto-draft new mail" sub={<>Drafts a reply to each new message. Mailing lists and automated mail are skipped. Set <span className="pg-mono">AUTO_DRAFT_ENABLED</span> in your Worker config to change.</>}>
								<span className="pg-tag">{autoDraft ? "on" : "off"} · config</span>
							</Setting>
							<Setting title="Sending" sub="The agent sends a draft when you ask it to. Auto-draft only drafts.">
								<span className="pg-tag">send_draft</span>
							</Setting>
							{/* TODO(roadmap): rules (Inquiry, Receipts, DMARC, Triage) and per-rule autonomy settings. */}
						</>
					)}
					{tab === "model" && <AgentModelSection draft={agentModel} />}
					{tab === "labels" && <LabelsTab />}
					{tab === "shortcuts" && <ShortcutList overrides={draft.shortcuts} onChange={(shortcuts) => setDraft({ ...draft, shortcuts })} />}
					{tab === "storage" && <StorageTab identities={identities} />}
				</div>
			</div>
			<div className="pg-modal-foot">
				<span className="pg-note" role="status">{error ?? (dirty ? "Unsaved changes" : "")}</span>
				<div className="pg-flex" />
				<button type="button" className="pg-btn" onClick={onClose}>Cancel</button>
				<button type="button" className="pg-btn pg-btn-primary" onClick={save} disabled={saving}>Save changes</button>
			</div>
		</Modal>
	);
}

const MCP_TOOLS = [
	["list_mailboxes", "List all mailboxes"],
	["list_emails", "List emails in a folder"],
	["get_email", "Read a full email with body"],
	["get_thread", "Load a conversation thread"],
	["search_emails", "Search emails by query"],
	["draft_reply", "Draft a reply to an email"],
	["create_draft", "Create a new draft"],
	["update_draft", "Edit a saved draft"],
	["send_draft", "Send a saved draft"],
	["mark_email_read", "Mark email as read/unread"],
	["move_email", "Move email to a system folder"],
	["list_labels", "List labels with counts"],
	["create_label", "Create a label"],
	["rename_label", "Rename a label"],
	["delete_label", "Delete a label"],
	["label_conversation", "Add or remove labels on a conversation"],
	["search_all_mail", "Search every address at once"],
	["label_matching", "Label every conversation a search matches"],
	["delete_email", "Move email to Trash"],
] as const;

export function McpModal({ onClose }: { onClose: () => void }) {
	const url = `${window.location.origin}/mcp`;
	const [copied, setCopied] = useState(false);
	return (
		<Modal className="is-mcp" label="Connect via MCP" onClose={onClose}>
			<Head icon={<PlugsConnectedIcon size={16} />} title="Connect via MCP" sub="Model Context Protocol server" onClose={onClose} />
			<div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "16px 18px", display: "flex", flexDirection: "column", gap: 16 }}>
				<span style={{ fontSize: 13, color: "var(--pg-text-5)", textWrap: "pretty" }}>
					Point Claude Code, Cursor or any MCP client at this server to read, search, draft, send and organize mail across every address. Requests go through Cloudflare Access like the app.
				</span>
				<div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
					<span className="pg-caption">SERVER URL</span>
					<div className="pg-mcp-url">
						<span>{url}</span>
						<button
							type="button"
							data-copied={copied}
							data-autofocus
							onClick={async () => {
								try {
									await navigator.clipboard.writeText(url);
									setCopied(true);
									setTimeout(() => setCopied(false), 2000);
								} catch {
									// Clipboard blocked: the URL stays selectable.
								}
							}}
						>
							{copied ? <CheckIcon size={12} weight="bold" /> : <CopyIcon size={12} />}{copied ? "Copied" : "Copy"}
						</button>
					</div>
				</div>
				<div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
					<span className="pg-caption">AVAILABLE TOOLS · {MCP_TOOLS.length}</span>
					<div className="pg-tools-list">
						{MCP_TOOLS.map(([name, desc]) => (
							<div key={name}>
								<WrenchIcon size={12} color="var(--pg-text-8)" />
								<code>{name}</code>
								<span>{desc}</span>
							</div>
						))}
					</div>
				</div>
			</div>
			<div className="pg-modal-foot">
				<span className="pg-note">send_draft sends each draft once.</span>
				<div className="pg-flex" />
				<button type="button" className="pg-btn pg-btn-primary" onClick={onClose}>Done</button>
			</div>
		</Modal>
	);
}

export function ShortcutsModal({ onClose, onEdit }: { onClose: () => void; onEdit: () => void }) {
	const [prefs] = usePrefs();
	return (
		<Modal className="is-shortcuts" label="Keyboard shortcuts" onClose={onClose}>
			<Head icon={<KeyboardIcon size={16} />} title="Keyboard shortcuts" sub="Press ? to open this list" onClose={onClose} />
			<div className="pg-keys-scroll">
				<ShortcutList overrides={prefs.shortcuts} />
			</div>
			<div className="pg-modal-foot">
				<div className="pg-flex" />
				<button type="button" className="pg-btn" onClick={onEdit}>Change keys</button>
				<button type="button" className="pg-btn pg-btn-primary" onClick={onClose} data-autofocus>Done</button>
			</div>
		</Modal>
	);
}

export function LogoutModal({ onClose }: { onClose: () => void }) {
	return (
		<Modal className="is-small" label="Log out" onClose={onClose}>
			<Head icon={<SignOutIcon size={16} />} title="Log out?" sub="Cloudflare Access session" onClose={onClose} danger />
			<div style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 10, fontSize: 13, color: "var(--pg-text-5)", textWrap: "pretty" }}>
				<span>You’ll be signed out of Cloudflare Access on this device and returned to the login page.</span>
				<span>Mail keeps arriving and agent drafts are kept. Nothing is sent while you’re away.</span>
			</div>
			<div className="pg-modal-foot">
				<div className="pg-flex" />
				<button type="button" className="pg-btn" onClick={onClose} data-autofocus>Cancel</button>
				<button type="button" className="pg-btn pg-btn-danger" onClick={() => { window.location.href = "/cdn-cgi/access/logout"; }}>
					<SignOutIcon size={13} weight="bold" />Log out
				</button>
			</div>
		</Modal>
	);
}

export interface ToastState {
	id: number;
	text: string;
	icon?: React.ReactNode;
	onUndo?: () => void;
}

export function Toast({ toast, onClose }: { toast: ToastState | null; onClose: () => void }) {
	useEffect(() => {
		if (!toast) return;
		const t = setTimeout(onClose, toast.onUndo ? 7000 : 5000);
		return () => clearTimeout(t);
	}, [toast, onClose]);
	if (!toast) return null;
	return (
		<div className="pg-toast" role="status" aria-live="polite">
			{toast.icon && <span style={{ display: "flex", color: "var(--pg-text-5)", marginRight: 4 }}>{toast.icon}</span>}
			<span className="pg-toast-text">{toast.text}</span>
			{toast.onUndo && (
				<>
					<span className="pg-sep" />
					<button type="button" className="pg-undo" onClick={toast.onUndo}>Undo<Keys id="undo" /></button>
				</>
			)}
			<button type="button" className="pg-x" aria-label="Dismiss" onClick={onClose} style={toast.onUndo ? undefined : { marginLeft: 6 }}><XIcon size={13} /></button>
		</div>
	);
}
