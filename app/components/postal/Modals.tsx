// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	ArrowCounterClockwiseIcon, AtIcon, CheckIcon, CopyIcon, DatabaseIcon, DesktopIcon, GearSixIcon, KeyboardIcon, MoonIcon,
	KeyIcon, MagnifyingGlassIcon, PlugsConnectedIcon, SignatureIcon, SignOutIcon, SlidersHorizontalIcon, SunIcon, TagIcon, WrenchIcon, XIcon,
} from "@phosphor-icons/react";
import { ClockCounterClockwiseIcon } from "@phosphor-icons/react";
import { AgentIcon } from "./AgentIcon";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { queryKeys } from "~/queries/keys";
import api from "~/services/api";
import { AgentModelSection, modelName, useAgentModelDraft, useModelCatalog } from "./ModelTab";
import { Segmented } from "./Segmented";
import { type AddressInfo, textToParagraphs } from "./compose";
import { Editor } from "./Editor";
import { htmlToPlainText } from "~/lib/utils";
import { AddressText, type Identities, Swatch } from "./identity";
import { LabelsTab } from "./LabelsTab";
import type { SettingsTab } from "./settings-tabs";
import { ActivityTab } from "./ActivityTab";
import { PlaybooksSection } from "./PlaybooksSection";
import { StorageTab } from "./StorageTab";
import { SEND_LIMITS } from "shared/send-limits";
import type { Prefs } from "./prefs";
import { ShortcutMap } from "./ShortcutMap";
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
				// Escape in a search box with text clears the box, and a step inside the dialog can take Escape for itself.
				if (e.target instanceof HTMLInputElement && e.target.type === "search" && e.target.value) return;
				if (e.target instanceof Element && e.target.closest("[data-own-escape]")) return;
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

function Head({ icon, title, sub, onClose, danger }: { icon: React.ReactNode; title: string; sub?: string; onClose: () => void; danger?: boolean }) {
	return (
		<div className="pg-modal-head">
			<span className={`pg-modal-icon${danger ? " is-danger" : ""}`}>{icon}</span>
			<div className="pg-modal-title">
				<h2>{title}</h2>
				{sub && <span>{sub}</span>}
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

function Setting({ title, sub, children }: { title: string; sub?: React.ReactNode; children: React.ReactNode }) {
	return (
		<div className="pg-setting">
			<div className="pg-setting-text"><b>{title}</b>{sub && <span>{sub}</span>}</div>
			{children}
		</div>
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
	const initialPrompts = Object.fromEntries(addresses.map((a) => [a, info.get(a)?.mailbox?.settings?.agentSystemPrompt ?? ""]));
	const [prompts, setPrompts] = useState<Record<string, string>>(initialPrompts);
	const promptChanged = (a: string) => (prompts[a] ?? "").trim() !== (initialPrompts[a] ?? "").trim();
	const [promptFor, setPromptFor] = useState(addresses[0] ?? "");
	const prompt = prompts[promptFor] ?? "";
	const setPrompt = (value: string) => setPrompts({ ...prompts, [promptFor]: value });
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const queryClient = useQueryClient();
	const agentModel = useAgentModelDraft();
	const { data: catalog } = useModelCatalog(tab === "agent");

	const dirty = !samePrefs(draft, prefs)
		|| addresses.some((a) => (names[a] ?? "") !== (initialNames[a] ?? ""))
		|| addresses.some(promptChanged)
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
				const signatureChanged = sigChanged(a);
				if (!nameChanged && !promptChanged(a) && !signatureChanged) return [];
				const sig = sigs[a];
				const empty = !sig?.html.replace(/<[^>]+>/g, "").trim();
				const settings = {
					...mailbox.settings,
					...(nameChanged ? { fromName: name } : {}),
					agentSystemPrompt: (prompts[a] ?? "").trim() || undefined,
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
		{ id: "activity", label: "Activity", icon: <ClockCounterClockwiseIcon size={16} /> },
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
							<div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, padding: "14px 0 8px" }}>
								<b style={{ fontWeight: 500 }}>Agent prompt</b>
								{addresses.length > 1 && (
									<select className="pg-select" value={promptFor} aria-label="Address this prompt is for" onChange={(e) => setPromptFor(e.target.value)}>
										{addresses.map((a) => <option key={a} value={a}>{a}</option>)}
									</select>
								)}
								<span className="pg-badge">{prompt.trim() ? "Custom" : "Default"}</span>
								<div className="pg-flex" />
								{addresses.length > 1 && addresses.some((a) => (prompts[a] ?? "").trim() !== prompt.trim()) && (
									<button type="button" className="pg-btn pg-btn-sm pg-btn-quiet" onClick={() => setPrompts(Object.fromEntries(addresses.map((a) => [a, prompt])))}>
										Use for every address
									</button>
								)}
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
								aria-label={`Agent prompt for ${promptFor}`}
								onChange={(e) => setPrompt(e.target.value)}
								placeholder="You are an email assistant that helps manage this inbox. You read emails, draft replies, and help organize conversations. Write like a real person. Short, direct, flowing prose. Plain text only. (Leave empty to use the built-in default prompt)"
							/>
							<div style={{ fontSize: 12, color: "var(--pg-text-6)", padding: "6px 0 4px" }}>Sent as the system message when the agent works on this address: Draft reply, auto-draft, and chat while its mail is open. Controls tone, style and behaviour rules.</div>
							<Setting title="Model" sub={agentModel.stored ? modelName(catalog, agentModel.stored.active) : ""}>
								<button type="button" className="pg-btn pg-btn-sm" onClick={() => onTab("model")}>Change</button>
							</Setting>
							<Setting title="Auto-draft new mail" sub={<>Drafts a reply to each new message. Mailing lists and automated mail are skipped. Set <span className="pg-mono">AUTO_DRAFT_ENABLED</span> in your Worker config to change.</>}>
								<span className="pg-tag">{autoDraft ? "on" : "off"} · config</span>
							</Setting>
							<Setting title="Sending" sub={`The agent sends a draft when you ask it to. Auto-draft only drafts. Agents and MCP clients send up to ${SEND_LIMITS.agentDay} messages a day per address, ${SEND_LIMITS.recipients.agent} recipients each.`}>
								<span className="pg-tag">send_draft</span>
							</Setting>
							{promptFor && <PlaybooksSection address={promptFor} />}
							{/* TODO(roadmap): rules (Inquiry, Receipts, DMARC, Triage) and per-rule autonomy settings. */}
						</>
					)}
					{tab === "model" && <AgentModelSection draft={agentModel} />}
					{tab === "labels" && <LabelsTab />}
					{tab === "shortcuts" && <ShortcutList overrides={draft.shortcuts} onChange={(shortcuts) => setDraft({ ...draft, shortcuts })} />}
					{tab === "activity" && (
						<ActivityTab
							addresses={addresses}
							identities={identities}
							days={draft.activityDays}
							onDays={(activityDays) => setDraft({ ...draft, activityDays })}
							autoDraft={autoDraft}
						/>
					)}
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
	["list_shortcuts", "List keyboard shortcuts"],
	["set_shortcut", "Rebind a keyboard shortcut"],
	["reset_shortcuts", "Restore default shortcut keys"],
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
	return (
		<Modal className="is-shortcuts" label="Keyboard shortcuts" onClose={onClose}>
			<Head icon={<KeyboardIcon size={16} />} title="Keyboard shortcuts" onClose={onClose} />
			<div className="pg-keys-scroll">
				<ShortcutMap onAll={onEdit} />
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
