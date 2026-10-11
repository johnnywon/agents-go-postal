// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	ArrowCounterClockwiseIcon, ArrowsClockwiseIcon, AtIcon, CheckIcon, CopyIcon, DatabaseIcon, DesktopIcon, GearSixIcon, MoonIcon,
	KeyIcon, PlugsConnectedIcon, SignatureIcon, SignOutIcon, SparkleIcon, SlidersHorizontalIcon, SunIcon, WrenchIcon, XIcon,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { queryKeys } from "~/queries/keys";
import api, { type AgentProvider, type IndexStatusResponse } from "~/services/api";
import { type AddressInfo, textToParagraphs } from "./compose";
import { Editor } from "./Editor";
import { htmlToPlainText } from "~/lib/utils";
import { AddressText, type Identities, Swatch } from "./identity";
import type { Prefs } from "./prefs";

function Modal({ className = "", label, onClose, children }: { className?: string; label: string; onClose: () => void; children: React.ReactNode }) {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const previous = document.activeElement as HTMLElement | null;
		ref.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
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

function Setting({ title, sub, children }: { title: string; sub: React.ReactNode; children: React.ReactNode }) {
	return (
		<div className="pg-setting">
			<div className="pg-setting-text"><b>{title}</b><span>{sub}</span></div>
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
	const current = {
		provider: provider ?? stored?.provider ?? "workers-ai",
		model: model ?? stored?.model ?? "",
	};
	const dirty = !!stored && (current.provider !== stored.provider || current.model.trim() !== stored.model || key.trim() !== "" || removeKey);
	const save = async () => {
		const view = await api.updateAgentModel({
			provider: current.provider,
			model: current.model.trim(),
			apiKey: removeKey ? "" : key.trim() || undefined,
		});
		queryClient.setQueryData(["agent-model"], view);
	};
	return { stored, ...current, key, removeKey, dirty, save, setProvider, setModel, setKey, setRemoveKey };
}

type AgentModelDraft = ReturnType<typeof useAgentModelDraft>;

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
				title="Model"
				sub={openrouter
					? "Chat and auto-draft run on OpenRouter and bill your OpenRouter account. Safety checks on incoming mail stay on Workers AI."
					: <>Workers AI, <span className="pg-mono">{draft.stored?.defaultModel ?? "default"}</span>. No key needed.</>}
			>
				<Segmented<AgentProvider>
					label="Agent model provider"
					value={draft.provider}
					onChange={(v) => { draft.setProvider(v); setTest({ busy: false }); }}
					options={[{ value: "workers-ai", label: "Workers AI" }, { value: "openrouter", label: "OpenRouter" }]}
				/>
			</Setting>
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

type Tab = "general" | "addresses" | "signatures" | "agent" | "model" | "index";

function indexRowMatches(row: IndexStatusResponse["mailboxes"][number]) {
	const s = row.source;
	const i = row.index;
	if (row.error || !s || !i) return false;
	const states = new Set([...Object.keys(s.counts.states), ...Object.keys(i.states)]);
	return [...states].every((k) => (s.counts.states[k] ?? 0) === (i.states[k] ?? 0))
		&& s.counts.unread === i.unread && s.counts.starred === i.starred && s.inboxConversations === i.inboxConversations;
}

export function SettingsModal({ initialTab, prefs, setPrefs, addresses, identities, info, autoDraft, onClose, onSaved }: {
	initialTab?: Tab;
	prefs: Prefs;
	setPrefs: (p: Partial<Prefs>) => void;
	addresses: string[];
	identities: Identities;
	info: ReadonlyMap<string, AddressInfo>;
	autoDraft: boolean;
	onClose: () => void;
	onSaved: (message: string) => void;
}) {
	const [tab, setTab] = useState<Tab>(initialTab ?? "general");
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

	const dirty = JSON.stringify(draft) !== JSON.stringify(prefs)
		|| addresses.some((a) => (names[a] ?? "") !== (initialNames[a] ?? ""))
		|| prompt.trim() !== initialPrompt.trim()
		|| addresses.some(sigChanged)
		|| agentModel.dirty;

	const save = async () => {
		setSaving(true);
		setError(null);
		try {
			setPrefs(draft);
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

	const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
		{ id: "general", label: "General", icon: <SlidersHorizontalIcon size={16} /> },
		{ id: "addresses", label: "Addresses", icon: <AtIcon size={16} /> },
		{ id: "signatures", label: "Signatures", icon: <SignatureIcon size={16} /> },
		{ id: "agent", label: "Agent", icon: <SparkleIcon size={16} /> },
		{ id: "model", label: "Model & key", icon: <KeyIcon size={16} /> },
		{ id: "index", label: "Mail index", icon: <DatabaseIcon size={16} /> },
	];

	return (
		<Modal label="Settings" onClose={onClose}>
			<Head icon={<GearSixIcon size={16} />} title="Settings" sub="saved in this browser · per-address settings sync to each mailbox" onClose={onClose} />
			<div className="pg-settings">
				<div className="pg-tabs" role="tablist" aria-label="Settings sections">
					{tabs.map((t) => (
						<button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>{t.icon}<span>{t.label}</span></button>
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
							<Setting title="Show keyboard shortcuts" sub="Key hints like ⌘K and E next to buttons. Shortcuts still work when hidden.">
								<Switch label="Show keyboard shortcuts" on={draft.keys} onChange={(keys) => setDraft({ ...draft, keys })} />
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
							<Setting title="Model" sub={agentModel.stored?.provider === "openrouter" ? `OpenRouter, ${agentModel.stored.model}` : "Workers AI (default)"}>
								<button type="button" className="pg-btn pg-btn-sm" onClick={() => setTab("model")}>Change</button>
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
					{tab === "index" && <IndexTab />}
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

function IndexTab() {
	const queryClient = useQueryClient();
	const { data, error, isLoading } = useQuery({
		queryKey: ["index-status"],
		queryFn: () => api.getIndexStatus(),
		refetchInterval: (q) => (q.state.data?.job && !q.state.data.job.finishedAt ? 3_000 : false),
	});
	const rebuild = useMutation({
		mutationFn: () => api.rebuildIndex(),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ["index-status"] }),
	});
	const rows = data?.mailboxes ?? [];
	const matching = rows.filter(indexRowMatches).length;
	const job = data?.job;
	const running = !!job && !job.finishedAt;
	const jobText = !job
		? "no rebuild has run"
		: running
			? `rebuilding ${job.position} of ${job.mailboxes.length}`
			: `last rebuild ${new Date(job.finishedAt!).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
	return (
		<div style={{ padding: "14px 0", display: "flex", flexDirection: "column", gap: 12 }}>
			<div className="pg-index-card">
				<DatabaseIcon size={18} color="var(--pg-text-5)" />
				<div className="pg-card-text">
					<b style={{ fontWeight: 600 }}>{isLoading ? "Checking…" : error ? "Could not read the index" : `${matching} of ${rows.length} addresses match`}</b>
					<span>{data ? `${data.messages.toLocaleString()} messages indexed · ${jobText}` : ""}</span>
				</div>
				<button type="button" className="pg-btn" onClick={() => rebuild.mutate()} disabled={rebuild.isPending || running}>
					<ArrowsClockwiseIcon size={13} />{running ? "Rebuilding" : "Rebuild"}
				</button>
			</div>
			{rebuild.isError && <span style={{ fontSize: 12, color: "var(--pg-danger-text)" }}>Rebuild failed to start.</span>}
			<span style={{ fontSize: 12, color: "var(--pg-text-6)" }}>
				The combined index merges every address into one list. If counts drift from a mailbox, rebuild it. Changes queue in each mailbox while <span className="pg-mono">INDEX_SYNC_ENABLED</span> is off. <a href="/settings/index">Per-address detail</a>
			</span>
		</div>
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
					<button type="button" className="pg-undo" onClick={toast.onUndo}>Undo<span className="pg-kbd">Z</span></button>
				</>
			)}
			<button type="button" className="pg-x" aria-label="Dismiss" onClick={onClose} style={toast.onUndo ? undefined : { marginLeft: 6 }}><XIcon size={13} /></button>
		</div>
	);
}
