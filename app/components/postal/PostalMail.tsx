// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { ArchiveIcon, ClockIcon, EnvelopeOpenIcon, EnvelopeSimpleIcon, FileIcon, PaperPlaneTiltIcon, StarIcon, TagIcon, TrashIcon, WarningIcon } from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { LABEL_COLORS } from "shared/label-colors";
import { type BulkAction, applyAction, readToggle, starToggle } from "~/lib/bulk-optimistic";
import { type MailFilter, type OpenRef, filterToParams, openParam, parseOpen, VIEW_LABELS } from "~/lib/mail-filter";
import * as sel from "~/lib/selection";
import { useBulkAction, useUndoBulk } from "~/queries/bulk";
import { useCreateLabel, useLabels } from "~/queries/labels";
import { useMailFacets, useMailList, useViewCounts } from "~/queries/mail";
import api, { ApiError, type BulkResult, type Conversation, type Label } from "~/services/api";
import type { Email } from "~/types";
import { AgentDraftRunner, AgentPanel, AgentRail, type DraftJob, type DraftResult } from "./Agent";
import {
	type ComposeMode, type ComposeState, composeFor, composeFromDraft, emptyCompose, handOff, HANDOFF_KEY, takeHandoff, useAddressInfo,
	useMailSender,
} from "./compose";
import { ComposeWindow } from "./ComposeWindow";
import { buildIdentities } from "./identity";
import { ListPane } from "./ListPane";
import { LogoutModal, McpModal, SettingsModal, Toast, type ToastState } from "./Modals";
import { conversations, HOME, labelOf, parsePostalFilter, scopeOf, searchTerms, withSearch } from "./model";
import { useLayout, usePrefs, useResolvedTheme, useWidth } from "./prefs";
import { Reader } from "./Reader";
import { SearchBar, type FilterSuggestion } from "./SearchBar";
import { NavRail, Sidebar } from "./Sidebar";

const EDITABLE = "input, textarea, select, [contenteditable=''], [contenteditable='true']";
const ICON = 15;

function actionText(action: BulkAction, n: number, labelName?: string): [string, React.ReactNode] {
	const what = conversations(n);
	switch (action.type) {
		case "archive": return [`Archived ${what}`, <ArchiveIcon size={ICON} />];
		case "trash": return [`Moved ${what} to Trash`, <TrashIcon size={ICON} />];
		case "restore": return [`Moved ${what} to Inbox`, <ArchiveIcon size={ICON} />];
		case "move": return [`Moved ${what} to ${VIEW_LABELS[action.folder] ?? action.folder}`, <ArchiveIcon size={ICON} />];
		case "label_add": return [`Added ${labelName ?? "label"} to ${what}`, <TagIcon size={ICON} />];
		case "label_remove": return [`Removed ${labelName ?? "label"} from ${what}`, <TagIcon size={ICON} />];
		case "read": return [`Marked ${what} read`, <EnvelopeOpenIcon size={ICON} />];
		case "unread": return [`Marked ${what} unread`, <EnvelopeSimpleIcon size={ICON} />];
		case "star": return [`Starred ${what}`, <StarIcon size={ICON} />];
		case "unstar": return [`Unstarred ${what}`, <StarIcon size={ICON} />];
	}
}

function useDebounced<T>(value: T, ms: number): T {
	const [v, setV] = useState(value);
	useEffect(() => {
		const t = setTimeout(() => setV(value), ms);
		return () => clearTimeout(t);
	}, [value, ms]);
	return v;
}

export default function PostalMail({ addresses, domains, autoDraft }: { addresses: string[]; domains: string[]; autoDraft: boolean }) {
	const [searchParams, setSearchParams] = useSearchParams();
	const queryClient = useQueryClient();
	const identities = useMemo(() => buildIdentities(domains, addresses), [domains, addresses]);
	const [prefs, setPrefs] = usePrefs();
	const [layout, setLayout] = useLayout();
	const theme = useResolvedTheme(prefs.theme);
	const width = useWidth();
	const mobile = width <= 600;
	const narrow = width < 1300;

	// ── URL state ──────────────────────────────────────────────────
	const filter = useMemo(() => parsePostalFilter(searchParams), [searchParams]);
	const open = useMemo(() => parseOpen(searchParams), [searchParams]);
	const filterKey = filterToParams(filter).toString();
	const [search, setSearchText] = useState(() => searchParams.get("search") ?? "");
	const debounced = useDebounced(search, 250);
	const { labels, byId: labelsById } = useLabels();
	const labelRefs = useMemo(() => labels.map((l) => ({ id: l.id, name: l.name })), [labels]);
	const effective = useMemo(() => withSearch(filter, debounced, labelRefs), [filter, debounced, labelRefs]);
	const effectiveKey = filterToParams(effective).toString();
	const terms = useMemo(() => searchTerms(debounced, labelRefs), [debounced, labelRefs]);

	const write = useCallback(
		(next: MailFilter, nextOpen: OpenRef | null, replace = false, nextSearch = debounced) => {
			const params = filterToParams(next);
			if (nextOpen) params.set("open", openParam(nextOpen));
			if (nextSearch.trim()) params.set("search", nextSearch);
			setSearchParams(params, { replace });
		},
		[debounced, setSearchParams],
	);

	// The search text lives in the URL once typing pauses.
	useEffect(() => {
		if ((searchParams.get("search") ?? "") === debounced) return;
		write(filter, open, true, debounced);
	}, [debounced]); // eslint-disable-line react-hooks/exhaustive-deps

	// ── Data ───────────────────────────────────────────────────────
	const list = useMailList(effective);
	const pages = list.data?.pages ?? [];
	const serverRows = useMemo(() => pages.flatMap((p) => p.conversations), [pages]);
	const total = pages[0]?.total ?? serverRows.length;
	const counts = useViewCounts();
	const unreadFacets = useMailFacets({ view: "inbox", chips: [{ kind: "is", value: "unread" }], sort: "date", dir: "desc" }, true);
	const unreadByAddress = useMemo(() => new Map((unreadFacets.data?.address ?? []).map((f) => [f.value.toLowerCase(), f.count])), [unreadFacets.data]);
	const [facetsWanted, setFacetsWanted] = useState(false);
	const [searchFocus, setSearchFocus] = useState(false);
	const listFacets = useMailFacets(filter, facetsWanted || searchFocus);
	const info = useAddressInfo(addresses);
	const sender = useMailSender(info);
	const createLabel = useCreateLabel();
	const bulk = useBulkAction(effective);
	const undo = useUndoBulk();
	const scheduledQuery = useQuery({ queryKey: ["scheduled"], queryFn: () => api.getScheduled(), enabled: filter.view === "drafts", refetchInterval: 30_000 });
	const scheduled = useMemo(() => new Map((scheduledQuery.data ?? []).map((s) => [s.emailId, s])), [scheduledQuery.data]);

	// Conversations opened since the filter changed stay listed even when they stop matching (read under Unread only).
	const [kept, setKept] = useState<Map<string, Conversation>>(new Map());
	const [selection, setSelection] = useState<sel.Selection>(sel.EMPTY_SELECTION);
	const keptFor = useRef(effectiveKey);
	if (keptFor.current !== effectiveKey) {
		keptFor.current = effectiveKey;
		if (kept.size) setKept(new Map());
		if (selection !== sel.EMPTY_SELECTION) setSelection(sel.EMPTY_SELECTION);
	}
	const rows = useMemo(() => {
		const present = new Set(serverRows.map((r) => r.thread_key));
		const extra = [...kept.values()].filter((c) => !present.has(c.thread_key));
		if (!extra.length) return serverRows;
		const out = [...serverRows];
		for (const c of extra) {
			const at = out.findIndex((r) => (effective.dir === "asc" ? r.date > c.date : r.date < c.date));
			out.splice(at < 0 ? out.length : at, 0, c);
		}
		return out;
	}, [serverRows, kept, effective.dir]);
	const rowKeys = useMemo(() => rows.map((r) => r.thread_key), [rows]);
	const checked = useMemo(() => sel.prune(selection, rowKeys), [selection, rowKeys]);
	const openRow = open ? rows.find((r) => r.mailbox_id === open.mailboxId && r.email_id === open.emailId) : undefined;
	const [currentKey, setCurrentKey] = useState<string | null>(null);
	const activeKey = openRow?.thread_key ?? (open ? currentKey : null);
	const [autoOpenedKey, setAutoOpenedKey] = useState<string | null>(null);

	// ── UI state ───────────────────────────────────────────────────
	const [navTemp, setNavTemp] = useState(false);
	const [panelTemp, setPanelTemp] = useState(false);
	const navOpen = mobile ? navTemp : narrow ? navTemp : layout.nav ?? true;
	const panelOpen = mobile ? panelTemp : narrow ? panelTemp : layout.panel ?? true;
	const showAside = !mobile && ((width >= 1500 && !panelOpen) || width >= 1800);
	const [modal, setModal] = useState<"settings" | "mcp" | "logout" | null>(null);
	const [toast, setToast] = useState<ToastState | null>(null);
	const [cw, setCw] = useState<{ key: number; initial: ComposeState; max?: boolean } | null>(null);
	const [inline, setInline] = useState<ComposeState | null>(null);
	const [prefill, setPrefill] = useState<{ text: string; id: number } | null>(null);
	const [agentBusy, setAgentBusy] = useState(false);
	const [replyRequest, setReplyRequest] = useState<{ mode: Exclude<ComposeMode, "new">; id: number } | null>(null);
	const [draftJob, setDraftJob] = useState<DraftJob | null>(null);
	const draftWaiter = useRef<{ resolve: (r: DraftResult) => void; reject: (e: Error) => void } | null>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const lastG = useRef(0);

	const showToast = useCallback((t: Omit<ToastState, "id">) => setToast({ ...t, id: Date.now() }), []);
	const closeToast = useCallback(() => setToast(null), []);

	const toggleNav = () => {
		if (mobile || narrow) setNavTemp((v) => !v);
		else setLayout({ nav: !navOpen });
	};
	const togglePanel = () => {
		if (mobile || narrow) setPanelTemp((v) => !v);
		else setLayout({ panel: !panelOpen });
	};

	// Reset inline composer when the open conversation changes.
	useEffect(() => setInline(null), [open?.mailboxId, open?.emailId]);

	// ── Navigation ─────────────────────────────────────────────────
	const go = useCallback(
		(next: MailFilter) => {
			setSearchText("");
			write(next, null, false, "");
			if (mobile) setNavTemp(false);
			else if (narrow) setNavTemp(false);
		},
		[write, mobile, narrow],
	);

	const openConversation = useCallback(
		(row: Conversation, auto = false) => {
			setCurrentKey(row.thread_key);
			setAutoOpenedKey((prev) => (auto ? row.thread_key : prev === row.thread_key ? null : prev));
			if (!auto && prefs.markRead) setKept((prev) => new Map(prev).set(row.thread_key, { ...row, unread: false, thread_unread_count: 0 }));
			write(filter, { mailboxId: row.mailbox_id, emailId: row.email_id }, true);
		},
		[filter, write, prefs.markRead],
	);

	const closeConversation = () => write(filter, null, true);

	// Two-pane layouts open the first conversation once per filter.
	const autoFor = useRef<string | null>(null);
	useEffect(() => {
		if (mobile || open || !rows.length || autoFor.current === effectiveKey) return;
		autoFor.current = effectiveKey;
		openConversation(rows[0], true);
	}, [mobile, open, rows, effectiveKey, openConversation]);

	const move = (delta: number) => {
		if (!rows.length) return;
		const at = activeKey ? rows.findIndex((r) => r.thread_key === activeKey) : -1;
		const next = rows[Math.min(Math.max(at + delta, 0), rows.length - 1)];
		if (next && next.thread_key !== activeKey) openConversation(next);
	};

	// After an action removes the open conversation, open the next one below, else above.
	const onRemoved = (removed: ReadonlySet<string>) => {
		if (removed.size) {
			setKept((prev) => {
				const copy = new Map(prev);
				for (const k of removed) copy.delete(k);
				return copy;
			});
		}
		if (!activeKey || !removed.has(activeKey)) return;
		const at = rows.findIndex((r) => r.thread_key === activeKey);
		const below = rows.slice(at + 1).find((r) => !removed.has(r.thread_key));
		const above = rows.slice(0, Math.max(at, 0)).reverse().find((r) => !removed.has(r.thread_key));
		const next = at >= 0 ? below ?? above : undefined;
		if (next && !mobile) openConversation(next);
		else closeConversation();
	};

	// ── Actions ────────────────────────────────────────────────────
	const targets = (override?: Conversation[] | null): Conversation[] => {
		if (override?.length) return override.map((o) => rows.find((r) => r.thread_key === o.thread_key) ?? o);
		if (checked.keys.size) return rows.filter((r) => checked.keys.has(r.thread_key));
		return openRow ? [openRow] : [];
	};

	const undoAction = (undoId: string) => {
		setToast(null);
		undo.mutate(undoId, {
			onSuccess: () => showToast({ text: "Undone" }),
			onError: (e) => showToast({ text: `Could not undo. ${(e as Error).message}`, icon: <WarningIcon size={ICON} /> }),
		});
	};

	const run = (action: BulkAction, override?: Conversation[] | null, labelName?: string) => {
		const list = targets(override);
		if (!list.length) return;
		const removed = new Set(list.filter((r) => !applyAction(r, action, effective)).map((r) => r.thread_key));
		const [text, icon] = actionText(action, list.length, labelName);
		bulk.mutate(
			{ target: { threadKeys: list.map((r) => r.thread_key), view: effective.view }, action, patchKeys: list.map((r) => r.thread_key) },
			{
				onSuccess: (result) => {
					const done = result as BulkResult;
					const failed = done.failed?.length ? ` ${done.failed.length} address${done.failed.length === 1 ? "" : "es"} failed.` : "";
					showToast({ text: text + failed, icon, onUndo: done.undoId ? () => undoAction(done.undoId) : undefined });
				},
				onError: (e) => {
					const msg = e instanceof ApiError && e.status === 409 ? "The list changed. Nothing was changed." : `Could not update mail. ${(e as Error).message}`;
					showToast({ text: msg, icon: <WarningIcon size={ICON} /> });
				},
			},
		);
		if (!override) setSelection(sel.EMPTY_SELECTION);
		if (removed.size) onRemoved(removed);
	};

	const canTrash = filter.view !== "trash";
	const act = (kind: "archive" | "trash" | "read" | "star", override?: Conversation[] | null) => {
		const list = targets(override);
		if (!list.length) return;
		if (kind === "archive") run({ type: "archive" }, override);
		else if (kind === "trash") canTrash && run({ type: "trash" }, override);
		else if (kind === "star") run(starToggle(list), override);
		else run(readToggle(list), override);
	};

	const toggleLabel = (label: Label, add: boolean, rowsFor?: Conversation[]) =>
		run({ type: add ? "label_add" : "label_remove", labelId: label.id }, rowsFor ?? (openRow ? [openRow] : null), label.name);

	const newLabel = (name: string, applyTo?: Conversation[]) =>
		createLabel.mutate(
			{ name, color: LABEL_COLORS[labels.length % LABEL_COLORS.length].bg },
			{
				onSuccess: (label) => (applyTo ? toggleLabel(label, true, applyTo) : showToast({ text: `Created ${label.name}`, icon: <TagIcon size={ICON} /> })),
				onError: (e) => showToast({ text: (e as Error).message, icon: <WarningIcon size={ICON} /> }),
			},
		);

	// ── Compose ────────────────────────────────────────────────────
	const defaultFrom = () => {
		const scope = scopeOf(filter);
		if (scope?.includes("@")) return scope;
		return open?.mailboxId ?? addresses[0] ?? "";
	};

	const openCompose = (initial?: ComposeState, max = false) => {
		if (cw && !initial) return; // already open; the window keeps its draft
		setCw({ key: Date.now(), initial: initial ?? emptyCompose(defaultFrom()), max });
	};

	const startReply = (mode: Exclude<ComposeMode, "new">, original: Email, keepHtml?: string, askAgent?: boolean) => {
		if (!open) return;
		const from = open.mailboxId;
		setInline({ ...composeFor(mode, original, open.mailboxId, from), html: keepHtml ?? "", askAgent });
	};

	const editDraft = async (mailboxId: string, draftId: string, cached?: Email) => {
		try {
			const draft = cached ?? (await api.getEmail(mailboxId, draftId));
			const state = composeFromDraft(draft, mailboxId);
			// A scheduled draft holds the sent body, signature included; the composer adds it back on send.
			const sig = info.get(mailboxId)?.signatureHtml;
			if (sig && state.html.includes(sig)) state.html = state.html.replace(sig, "");
			openCompose(state);
		} catch {
			showToast({ text: "Could not open the draft.", icon: <WarningIcon size={ICON} /> });
		}
	};

	const popOut = (state: ComposeState, fallback: () => void) => {
		if (handOff(state)) {
			showToast({ text: "Opened in a new window", icon: <PaperPlaneTiltIcon size={ICON} /> });
			return true;
		}
		try {
			window.localStorage.removeItem(HANDOFF_KEY);
		} catch {
			// nothing to clean
		}
		fallback();
		return false;
	};

	const draftWithAgent = (state: ComposeState): Promise<DraftResult> => {
		const notes = state.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
		const to = state.to[0]?.addr;
		let mailboxId = state.from;
		let prompt: string;
		if ((state.mode === "reply" || state.mode === "reply-all") && state.originalId) {
			mailboxId = open?.mailboxId ?? state.from;
			prompt = `Draft a reply to email ${state.originalId} with draft_reply. Read the thread first.${to ? ` Address it to ${to}.` : ""}${notes ? ` Use these notes from me: ${notes}` : ""}`;
		} else {
			if (!to) return Promise.reject(new Error("Add a recipient first, then ask the agent."));
			prompt = `Draft a new email with draft_email to ${to}.${state.subject.trim() ? ` Subject: ${state.subject.trim()}.` : ""}${state.mode === "forward" && state.originalId ? ` It forwards email ${state.originalId}; write a short note to go with it.` : ""}${notes ? ` Use these notes from me: ${notes}` : ""}`;
		}
		if (draftWaiter.current) return Promise.reject(new Error("The agent is already drafting."));
		return new Promise<DraftResult>((resolve, reject) => {
			const timer = setTimeout(() => {
				draftWaiter.current = null;
				setDraftJob(null);
				reject(new Error("The agent took too long. Try again."));
			}, 120_000);
			draftWaiter.current = {
				resolve: (r) => {
					clearTimeout(timer);
					resolve(r);
				},
				reject: (e) => {
					clearTimeout(timer);
					reject(e);
				},
			};
			setDraftJob({ id: Date.now(), mailboxId, prompt });
		});
	};

	const finishDraft = (fn: (w: NonNullable<typeof draftWaiter.current>) => void) => {
		const waiter = draftWaiter.current;
		draftWaiter.current = null;
		setDraftJob(null);
		if (waiter) fn(waiter);
		queryClient.invalidateQueries({ queryKey: ["mail"] });
	};

	// A popped-out compose window arrives as #compose with its draft in storage.
	useEffect(() => {
		if (window.location.hash !== "#compose") return;
		const state = takeHandoff();
		history.replaceState(null, "", window.location.pathname + window.location.search);
		if (state) openCompose(state, true);
	}, []); // eslint-disable-line react-hooks/exhaustive-deps

	// ── Keyboard ───────────────────────────────────────────────────
	const togglePanelRef = useRef(togglePanel);
	togglePanelRef.current = togglePanel;
	const keys = useRef<(key: string, e?: KeyboardEvent) => boolean>(() => false);
	keys.current = (key, e) => {
		switch (key) {
			case "/": searchRef.current?.focus(); return true;
			case "c": openCompose(); return true;
			case "r": case "a": case "f":
				if (!open) return false;
				setReplyRequest({ mode: key === "r" ? "reply" : key === "a" ? "reply-all" : "forward", id: Date.now() });
				return true;
			case "z": if (toast?.onUndo) { toast.onUndo(); return true; } return false;
			case "e": act("archive"); return true;
			case "x":
				if (activeKey && rowKeys.includes(activeKey)) setSelection((s) => (e?.shiftKey ? sel.range(s, activeKey, rowKeys) : sel.toggle(s, activeKey)));
				return true;
			case "j": case "ArrowDown": move(1); return true;
			case "k": case "ArrowUp": move(-1); return true;
			case "Escape":
				if (inline) setInline(null);
				else if (checked.keys.size) setSelection(sel.EMPTY_SELECTION);
				else if (mobile && navTemp) setNavTemp(false);
				else if ((mobile || narrow) && panelTemp) setPanelTemp(false);
				else if (mobile && open) closeConversation();
				else return false;
				return true;
			case "g": lastG.current = Date.now(); return true;
			case "i":
				if (Date.now() - lastG.current < 1000) {
					go({ ...HOME, chips: [] });
					return true;
				}
				return false;
		}
		return false;
	};

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.defaultPrevented || e.isComposing) return;
			const target = e.target as Element | null;
			const inCompose = !!target?.closest?.(".pg-cw");
			if ((e.metaKey || e.ctrlKey) && !e.altKey) {
				const k = e.key.toLowerCase();
				if (k === "k" && !inCompose) {
					e.preventDefault();
					searchRef.current?.focus();
				} else if (k === "j") {
					e.preventDefault();
					togglePanelRef.current();
				}
				return;
			}
			if (e.altKey || document.querySelector(".pg-modal-scrim")) return;
			if (target?.closest?.(EDITABLE) || inCompose || target?.closest?.("[data-mail-popover]")) return;
			if (keys.current(e.key, e)) e.preventDefault();
		};
		const onMessage = (event: MessageEvent) => {
			const data = event.data as { __emailIframeKey?: boolean; key?: string } | null;
			if (!data || data.__emailIframeKey !== true || typeof data.key !== "string") return;
			if (![...document.querySelectorAll("iframe")].some((f) => f.contentWindow === event.source)) return;
			keys.current(data.key);
		};
		document.addEventListener("keydown", onKey);
		window.addEventListener("message", onMessage);
		return () => {
			document.removeEventListener("keydown", onKey);
			window.removeEventListener("message", onMessage);
		};
	}, []);
	// ── Derived display ────────────────────────────────────────────
	const scope = scopeOf(filter);
	const labelView = labelOf(filter);
	const searching = !!debounced.trim();
	const title = `${labelView ? labelsById.get(labelView)?.name ?? "Label" : scope ? `${scope}${filter.view !== "inbox" ? ` · ${VIEW_LABELS[filter.view] ?? filter.view}` : ""}` : filter.view === "inbox" ? "All inboxes" : VIEW_LABELS[filter.view] ?? filter.view}${searching ? " · search" : ""}`;
	const status = listFacets.data?.status;
	const topLabels = [...labels].sort((a, b) => b.count - a.count).slice(0, 2);
	const topFrom = (listFacets.data?.from.domains ?? []).slice(0, 2);
	const suggestions: FilterSuggestion[] = [
		{ token: "is:unread", desc: "Unread", icon: "unread", count: status?.unread },
		{ token: "is:starred", desc: "Starred", icon: "starred", count: status?.starred },
		{ token: "has:attachment", desc: "Has attachment", icon: "attachment", count: status?.attachment },
		// TODO(roadmap): an "is:waiting" (Needs you) suggestion returns with the Needs you view.
		...topLabels.map((l) => ({ token: `label:${/\s/.test(l.name) ? `"${l.name}"` : l.name.toLowerCase()}`, desc: l.name, icon: "label" as const, count: l.count })),
		...topFrom.map((f) => ({ token: `from:${f.value}`, desc: `From ${f.value}`, icon: "from" as const, count: f.count })),
	];
	const addressFacet = new Map((listFacets.data?.address ?? []).map((f) => [f.value.toLowerCase(), f.count]));
	const agentMailbox = open?.mailboxId ?? (scope?.includes("@") ? scope : addresses[0] ?? "");

	const sidebarProps = {
		identities, filter, go, allUnread: counts.unread, unreadByAddress, labels,
		onCreateLabel: (name: string) => newLabel(name),
		onAskLabel: (label: Label) => {
			if (!panelOpen) togglePanel();
			setPrefill({ text: `Which conversations did you label ${label.name}, and why?`, id: Date.now() });
			if (mobile) setNavTemp(false);
		},
		mailboxesOpen: layout.mailboxesOpen,
		labelsOpen: layout.labelsOpen,
		setLayout,
		onCollapse: toggleNav,
		onMcp: () => setModal("mcp"),
		onSettings: () => setModal("settings"),
		onLogout: () => setModal("logout"),
	};

	return (
		<div className="postal" data-theme={theme} data-keys={prefs.keys ? "on" : "off"} data-pane={mobile && open ? "reader" : "list"}>
			<div className="pg-body">
				{/* Below 1300px the rail stays in place and the full column overlays it. */}
				{!mobile && (!navOpen || narrow) && (
					<NavRail
						{...sidebarProps}
						onExpand={toggleNav}
						onLabels={() => {
							setLayout({ labelsOpen: true });
							toggleNav();
						}}
					/>
				)}
				{(mobile || navOpen) && (
					<Sidebar {...sidebarProps} overlay={!mobile && narrow} drawer={mobile ? (navTemp ? "open" : "closed") : undefined} />
				)}
				{(mobile || narrow) && navTemp && <div className="pg-drawer-scrim" onClick={() => setNavTemp(false)} aria-hidden />}
				<div className="pg-center">
					<SearchBar
						ref={searchRef}
						value={search}
						onChange={setSearchText}
						onOpenFirst={() => rows[0] && openConversation(rows[0])}
						onMove={move}
						resultCount={searching ? total : null}
						filters={suggestions}
						addresses={addresses.map((a) => ({ address: a, count: addressFacet.get(a) }))}
						identities={identities}
						onMenu={() => setNavTemp(true)}
						onAgent={togglePanel}
						onFocusChange={setSearchFocus}
					/>
					<div className="pg-panes">
						<ListPane
							identities={identities}
							filter={filter}
							go={go}
							title={title}
							searching={searching}
							allUnread={counts.unread}
							unreadByAddress={unreadByAddress}
							onNew={() => openCompose()}
							onRefresh={() => {
								queryClient.invalidateQueries({ queryKey: ["mail"] });
								queryClient.invalidateQueries({ queryKey: ["mail-facets"] });
							}}
							refreshing={list.isFetching && !list.isFetchingNextPage}
							facets={listFacets.data}
							onFacets={setFacetsWanted}
							labels={labels}
							labelsById={labelsById}
							rows={rows}
							total={total}
							loading={list.isPending}
							error={list.error}
							onRetry={() => list.refetch()}
							hasNextPage={!!list.hasNextPage}
							fetchingNext={list.isFetchingNextPage}
							fetchNext={() => list.fetchNextPage()}
							currentKey={activeKey}
							onOpen={(row) => openConversation(row)}
							checked={checked.keys}
							onCheck={(row, range) => setSelection((s) => (range ? sel.range(s, row.thread_key, rowKeys) : sel.toggle(s, row.thread_key)))}
							onSelectAll={() => setSelection((s) => sel.selectAll(s, rowKeys))}
							onClearSelection={() => setSelection(sel.EMPTY_SELECTION)}
							onRowAction={(row, action) => act(action, [row])}
							onBulk={(action) => act(action)}
							terms={terms}
							scheduled={scheduled}
							onCancelScheduled={async (s) => {
								try {
									await api.cancelScheduled(s.mailboxId, s.emailId);
									queryClient.invalidateQueries({ queryKey: ["scheduled"] });
									showToast({ text: "Schedule cancelled. The draft stays in Drafts.", icon: <ClockIcon size={ICON} /> });
								} catch (e) {
									showToast({ text: `Could not cancel. ${(e as Error).message}`, icon: <WarningIcon size={ICON} /> });
								}
							}}
							onClearSearch={() => setSearchText("")}
							onHome={() => go({ ...HOME, chips: [] })}
						/>
						<Reader
							row={openRow}
							open={open}
							autoOpened={!!openRow && openRow.thread_key === autoOpenedKey}
							identities={identities}
							info={info}
							addresses={addresses}
							prefs={prefs}
							labels={labels}
							labelsById={labelsById}
							showAside={showAside}
							canTrash={canTrash}
							onBack={closeConversation}
							onAction={(a) => act(a, openRow ? [openRow] : null)}
							onLabel={(label, add) => toggleLabel(label, add)}
							onCreateLabel={(name) => newLabel(name, openRow ? [openRow] : undefined)}
							inline={inline}
							setInline={setInline}
							startReply={startReply}
							sender={sender}
							onToast={(text) => showToast({ text, icon: <PaperPlaneTiltIcon size={ICON} /> })}
							onPopOut={(state) => {
								if (popOut(state, () => openCompose(state))) setInline(null);
								else setInline(null);
							}}
							onEditDraft={(draft) => open && editDraft(open.mailboxId, draft.id, draft)}
							draftWithAgent={draftWithAgent}
							replyRequest={replyRequest}
						/>
					</div>
				</div>
				{panelOpen ? (
					<>
						{mobile && <div className="pg-drawer-scrim" onClick={() => setPanelTemp(false)} aria-hidden />}
						<AgentPanel
							mailboxId={agentMailbox}
							identities={identities}
							onCollapse={togglePanel}
							overlay={!mobile && narrow}
							prefill={prefill}
							onOpenDraft={(mailboxId, draftId) => editDraft(mailboxId, draftId)}
							onBusy={setAgentBusy}
						/>
					</>
				) : (
					!mobile && <AgentRail onOpen={togglePanel} busy={agentBusy} />
				)}
			</div>
			{cw && (
				<ComposeWindow
					key={cw.key}
					initial={cw.initial}
					maximised={cw.max}
					addresses={addresses}
					identities={identities}
					info={info}
					sender={sender}
					draftWithAgent={draftWithAgent}
					onClosed={(message) => {
						// The open draft is gone once it is sent, scheduled anew or discarded.
						if (open && cw.initial.draftId === open.emailId && message && !message.startsWith("Draft saved")) closeConversation();
						setCw(null);
						if (message) showToast({ text: message, icon: message.startsWith("Scheduled") ? <ClockIcon size={ICON} /> : message.startsWith("Draft") ? <FileIcon size={ICON} /> : <PaperPlaneTiltIcon size={ICON} /> });
					}}
					onPopOut={(state) => {
						if (popOut(state, () => setCw({ key: Date.now(), initial: state }))) setCw(null);
					}}
				/>
			)}
			{draftJob && (
				<AgentDraftRunner
					key={draftJob.id}
					job={draftJob}
					onDone={(r) => finishDraft((w) => w.resolve(r))}
					onError={(m) => finishDraft((w) => w.reject(new Error(m)))}
				/>
			)}
			<Toast toast={toast} onClose={closeToast} />
			{modal === "settings" && (
				<SettingsModal
					prefs={prefs}
					setPrefs={setPrefs}
					addresses={addresses}
					identities={identities}
					info={info}
					autoDraft={autoDraft}
					onClose={() => setModal(null)}
					onSaved={(text) => showToast({ text })}
				/>
			)}
			{modal === "mcp" && <McpModal onClose={() => setModal(null)} />}
			{modal === "logout" && <LogoutModal onClose={() => setModal(null)} />}
		</div>
	);
}
