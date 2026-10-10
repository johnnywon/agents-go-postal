// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	ArchiveIcon, ArrowBendUpLeftIcon, EnvelopeOpenIcon, EnvelopeSimpleIcon, KeyboardIcon, MagnifyingGlassIcon, PencilSimpleIcon, RowsIcon, StarIcon,
	TagIcon, TrashIcon,
} from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LABEL_COLORS } from "shared/label-colors";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import AgentSidebar from "~/components/AgentSidebar";
import { useMailShortcuts } from "~/hooks/useMailShortcuts";
import { useUIStore } from "~/hooks/useUIStore";
import { type BulkAction, applyAction, readToggle, starToggle } from "~/lib/bulk-optimistic";
import * as sel from "~/lib/selection";
import {
	addChip,
	apiParams,
	applySearch,
	chipValues,
	filterToParams,
	type MailFilter,
	type OpenRef,
	parseFilter,
	parseOpen,
	removeChip,
	toSearch,
} from "~/lib/mail-filter";
import { useBulkAction, useUndoBulk } from "~/queries/bulk";
import { queryKeys } from "~/queries/keys";
import { useCreateLabel, useLabels } from "~/queries/labels";
import { useMailFacets, useMailFolders, useMailList, useViewCounts } from "~/queries/mail";
import api, { ApiError, type BulkJobStarted, type BulkResult, type BulkTarget, type Conversation } from "~/services/api";
import type { Email } from "~/types";
import BulkBar, { FOLDER_NAMES } from "./BulkBar";
import ConversationList from "./ConversationList";
import EmptyTrash from "./EmptyTrash";
import LabelPicker, { type PickerLabel } from "./LabelPicker";
import MailToast, { type ToastState } from "./MailToast";
import ScopeBar, { type PopoverKind } from "./ScopeBar";
import SourceList from "./SourceList";
import TopBar from "./TopBar";
import UnifiedReader from "./UnifiedReader";

const COMPACT_KEY = "agp.compact";
const LAST_FROM_KEY = "agp.last-from";
const WIDE_READER = "(min-width: 1100px)";

function readStorage(key: string): string | null {
	try {
		return window.localStorage.getItem(key);
	} catch {
		return null;
	}
}

function writeStorage(key: string, value: string) {
	try {
		window.localStorage.setItem(key, value);
	} catch {
		// Private windows and blocked storage: the preference lasts for this page only.
	}
}

function sortKey(c: Conversation, sort: MailFilter["sort"]): string {
	if (sort === "from") return (c.sender_name || c.sender_addr).toLowerCase();
	if (sort === "subject") return c.subject.toLowerCase().replace(/^((re|fwd?|fw|aw|wg|sv):\s*)+/i, "");
	return c.date;
}

/** Server rows plus conversations opened since the last filter change that the server no longer returns. */
function withKept(rows: Conversation[], kept: Map<string, Conversation>, filter: MailFilter): Conversation[] {
	const present = new Set(rows.map((r) => r.thread_key));
	const extra = [...kept.values()].filter((c) => !present.has(c.thread_key));
	if (!extra.length) return rows;
	const out = [...rows];
	const before = (a: Conversation, b: Conversation) => {
		const ka = sortKey(a, filter.sort);
		const kb = sortKey(b, filter.sort);
		if (ka === kb) return a.date > b.date;
		return filter.dir === "asc" ? ka < kb : ka > kb;
	};
	for (const c of extra) {
		const at = out.findIndex((r) => before(c, r));
		out.splice(at < 0 ? out.length : at, 0, c);
	}
	return out;
}

function conversations(n: number) {
	return `${n.toLocaleString()} conversation${n === 1 ? "" : "s"}`;
}

/** Toast text for a finished action. */
function actionMessage(action: BulkAction, count: number, labelName?: string): string {
	switch (action.type) {
		case "archive": return `Archived ${conversations(count)}.`;
		case "trash": return `Moved ${conversations(count)} to Trash.`;
		case "restore": return `Moved ${conversations(count)} to Inbox.`;
		case "move": return `Moved ${conversations(count)} to ${FOLDER_NAMES[action.folder]}.`;
		case "label_add": return `Added ${labelName ?? "label"} to ${conversations(count)}.`;
		case "label_remove": return `Removed ${labelName ?? "label"} from ${conversations(count)}.`;
		case "read": return `Marked ${conversations(count)} read.`;
		case "unread": return `Marked ${conversations(count)} unread.`;
		case "star": return `Starred ${conversations(count)}.`;
		case "unstar": return `Unstarred ${conversations(count)}.`;
	}
}

interface Targets {
	target: BulkTarget;
	/** Rows to patch now; null patches every loaded row. */
	patchKeys: string[] | null;
	count: number;
	rows: Conversation[];
}

function singleAddress(filter: MailFilter): string | null {
	const values = chipValues(filter, "address");
	return values.length === 1 && values[0].includes("@") ? values[0] : null;
}

export default function UnifiedMail({ addresses }: { addresses: string[] }) {
	const [searchParams, setSearchParams] = useSearchParams();
	const queryClient = useQueryClient();
	const filter = useMemo(() => parseFilter(searchParams), [searchParams]);
	const open = useMemo(() => parseOpen(searchParams), [searchParams]);
	const filterKey = filterToParams(filter).toString();
	const { isComposing, startCompose, isAgentPanelOpen, toggleAgentPanel } = useUIStore();

	const list = useMailList(filter);
	const pages = list.data?.pages ?? [];
	const serverRows = useMemo(() => pages.flatMap((p) => p.conversations), [pages]);
	const firstPage = pages[0];
	const counts = useViewCounts();
	const total = firstPage?.total ?? 0;
	const { data: folders = [] } = useMailFolders();

	const { labels: labelList, byId: labels, names: labelNames } = useLabels();
	const [kept, setKept] = useState<Map<string, Conversation>>(new Map());
	const [currentKey, setCurrentKey] = useState<string | null>(null);
	// The conversation the wide reader opened by itself. It stays unread until the user opens it.
	const [autoOpenedKey, setAutoOpenedKey] = useState<string | null>(null);
	const [selectionState, setSelection] = useState<sel.Selection>(sel.EMPTY_SELECTION);
	const keptFor = useRef(filterKey);
	if (keptFor.current !== filterKey) {
		keptFor.current = filterKey;
		if (kept.size) setKept(new Map());
		if (selectionState !== sel.EMPTY_SELECTION) setSelection(sel.EMPTY_SELECTION);
	}
	const rows = useMemo(() => withKept(serverRows, kept, filter), [serverRows, kept, filter]);
	const openRow = open ? rows.find((r) => r.mailbox_id === open.mailboxId && r.email_id === open.emailId) : undefined;
	const activeKey = openRow?.thread_key ?? (open ? currentKey : null);
	const rowKeys = useMemo(() => rows.map((r) => r.thread_key), [rows]);
	const selection = useMemo(() => sel.prune(selectionState, rowKeys), [selectionState, rowKeys]);

	const [openPopover, setOpenPopover] = useState<PopoverKind | null>(null);
	const [keysOpen, setKeysOpen] = useState(false);
	const [sourcesOpen, setSourcesOpen] = useState(false);
	const [compact, setCompact] = useState(() => typeof window !== "undefined" && readStorage(COMPACT_KEY) === "1");
	const [search, setSearch] = useState("");
	const searchRef = useRef<HTMLInputElement>(null);
	const [composeFrom, setComposeFromState] = useState(() =>
		singleAddress(filter) ?? (typeof window !== "undefined" ? readStorage(LAST_FROM_KEY) : null) ?? addresses[0] ?? "",
	);
	const [agentPick, setAgentPick] = useState(addresses[0] ?? "");
	const [picker, setPicker] = useState<{ rows: Conversation[] | null; from: "toolbar" | "bulk" } | null>(null);
	const [toast, setToast] = useState<ToastState | null>(null);
	const [job, setJob] = useState<(BulkJobStarted & { message: string; action: BulkAction | { type: "empty_trash" } }) | null>(null);
	const bulk = useBulkAction(filter);
	const undo = useUndoBulk();
	const createLabel = useCreateLabel();
	const pickerFacets = useMailFacets(filter, !!picker);
	const closeToast = useCallback(() => setToast(null), []);
	const showToast = useCallback((next: Omit<ToastState, "id">) => setToast({ ...next, id: Date.now() }), []);

	const setComposeFrom = (address: string) => {
		setComposeFromState(address);
		writeStorage(LAST_FROM_KEY, address);
	};

	const go = useCallback(
		(next: MailFilter, options: { replace?: boolean; open?: OpenRef | null } = {}) => {
			const target = options.open === undefined ? open : options.open;
			setSearchParams(new URLSearchParams(toSearch(next, target)), { replace: options.replace });
		},
		[open, setSearchParams],
	);

	const openConversation = useCallback(
		(row: Conversation, replace = true, auto = false) => {
			setCurrentKey(row.thread_key);
			// Clear the flag only for the row the user opened; the reader may still show the auto-opened one for a render.
			setAutoOpenedKey((prev) => (auto ? row.thread_key : prev === row.thread_key ? null : prev));
			// Opening marks it read; keep it on screen even if the filter is is:unread.
			if (!auto) setKept((prev) => new Map(prev).set(row.thread_key, { ...row, unread: false, thread_unread_count: 0 }));
			go(filter, { replace, open: { mailboxId: row.mailbox_id, emailId: row.email_id } });
			setSourcesOpen(false);
		},
		[filter, go],
	);

	// Legacy /mailbox/:id?compose=new arrives as ?compose=new.
	useEffect(() => {
		if (searchParams.get("compose") !== "new") return;
		const address = singleAddress(filter);
		if (address) setComposeFrom(address);
		startCompose({ mode: "new" });
		const next = new URLSearchParams(searchParams);
		next.delete("compose");
		setSearchParams(next, { replace: true });
	}, [searchParams, filter, startCompose, setSearchParams]); // eslint-disable-line react-hooks/exhaustive-deps

	// Wide screens open the first conversation once per filter when nothing is open.
	const autoOpenedFor = useRef<string | null>(null);
	useEffect(() => {
		if (open || isComposing || !rows.length || autoOpenedFor.current === filterKey) return;
		if (typeof window === "undefined" || !window.matchMedia(WIDE_READER).matches) return;
		autoOpenedFor.current = filterKey;
		openConversation(rows[0], true, true);
	}, [open, isComposing, rows, filterKey, openConversation]);

	const move = (delta: number) => {
		if (!rows.length) return;
		const index = activeKey ? rows.findIndex((r) => r.thread_key === activeKey) : -1;
		const next = rows[Math.min(Math.max(index + delta, 0), rows.length - 1)];
		if (next && next.thread_key !== activeKey) openConversation(next);
	};

	// After an action removes the open conversation, open the next remaining row below, else the one above.
	const onRemoved = (removed: ReadonlySet<string> = new Set(activeKey ? [activeKey] : [])) => {
		if (removed.size) {
			setKept((prev) => {
				const copy = new Map(prev);
				for (const key of removed) copy.delete(key);
				return copy;
			});
		}
		if (!activeKey || !removed.has(activeKey)) return;
		const index = rows.findIndex((r) => r.thread_key === activeKey);
		const below = rows.slice(index + 1).find((r) => !removed.has(r.thread_key));
		const above = rows.slice(0, Math.max(index, 0)).reverse().find((r) => !removed.has(r.thread_key));
		const next = index >= 0 ? below ?? above : undefined;
		if (next) openConversation(next);
		else go(filter, { replace: true, open: null });
	};

	// ── Bulk actions ────────────────────────────────────────────────

	/** Rows an action applies to: the given rows, else the checked rows (or all matching), else the open conversation. */
	const resolveTargets = (override?: Conversation[] | null): Targets | null => {
		const keyed = (list: Conversation[]): Targets => ({
			target: { threadKeys: list.map((r) => r.thread_key), view: filter.view },
			patchKeys: list.map((r) => r.thread_key),
			count: list.length,
			rows: list,
		});
		// Re-read override rows from the list so checkmarks follow optimistic label changes.
		if (override?.length) return keyed(override.map((o) => rows.find((r) => r.thread_key === o.thread_key) ?? o));
		if (selection.allMatching) {
			return {
				target: { filter: apiParams(filter).toString(), asOf: new Date(list.dataUpdatedAt || Date.now()).toISOString(), expectedCount: total },
				patchKeys: null,
				count: total,
				rows,
			};
		}
		if (selection.keys.size) return keyed(rows.filter((r) => selection.keys.has(r.thread_key)));
		if (openRow) return keyed([openRow]);
		return null;
	};

	const run = (action: BulkAction, override?: Conversation[] | null, labelName?: string) => {
		const targets = resolveTargets(override);
		if (!targets) return;
		const removed = new Set(
			targets.rows.filter((r) => (targets.patchKeys === null || targets.patchKeys.includes(r.thread_key)) && !applyAction(r, action, filter))
				.map((r) => r.thread_key),
		);
		const message = actionMessage(action, targets.count, labelName);
		bulk.mutate({ target: targets.target, action, patchKeys: targets.patchKeys }, {
			onSuccess: (result) => {
				if ("jobId" in result) {
					setJob({ ...(result as BulkJobStarted), message, action });
					showToast({ message: `Working on ${result.total.toLocaleString()} messages.`, sticky: true });
					return;
				}
				const done = result as BulkResult;
				const failed = done.failed.length ? ` ${done.failed.length} address${done.failed.length === 1 ? "" : "es"} failed: ${done.failed[0].error}` : "";
				showToast({ message: message + failed, onUndo: () => undoAction(done.undoId) });
			},
			onError: (error) => {
				if (error instanceof ApiError && error.status === 409) {
					showToast({ message: `The list changed: ${Number(error.body.count ?? 0).toLocaleString()} match now. Nothing was changed.` });
				} else {
					showToast({ message: `Could not update mail. ${(error as Error).message}` });
				}
			},
		});
		if (removed.size) {
			if (!override) setSelection(sel.EMPTY_SELECTION);
			onRemoved(removed);
		}
	};

	const undoAction = (undoId: string) => {
		setToast(null);
		undo.mutate(undoId, {
			onSuccess: () => showToast({ message: "Undone." }),
			onError: (error) => showToast({ message: `Could not undo. ${(error as Error).message}` }),
		});
	};

	// Large actions run as a job; poll it and offer Undo when it finishes.
	const jobQuery = useQuery({
		queryKey: ["bulk-job", job?.jobId],
		queryFn: () => api.getBulkJob(job!.jobId),
		enabled: !!job,
		refetchInterval: 1_000,
	});
	useEffect(() => {
		const data = jobQuery.data;
		if (!job || !data) return;
		if (!data.finishedAt) {
			showToast({ message: `Working: ${data.done.toLocaleString()} of ${data.total.toLocaleString()} steps.`, sticky: true });
			return;
		}
		const undoId = job.undoId;
		const emptied = job.action.type === "empty_trash";
		setJob(null);
		queryClient.invalidateQueries({ queryKey: ["mail"] });
		queryClient.invalidateQueries({ queryKey: ["labels"] });
		if (emptied) {
			queryClient.invalidateQueries({ queryKey: ["mail-trash"] });
			if (filter.view === "trash") {
				setKept(new Map());
				if (open) go(filter, { replace: true, open: null });
			}
		}
		const failed = data.failed.length ? ` ${data.failed.length} address${data.failed.length === 1 ? "" : "es"} failed.` : "";
		const message = emptied ? `Deleted ${data.affected.toLocaleString()} messages forever.` : job.message;
		showToast({ message: message + failed, onUndo: emptied ? undefined : () => undoAction(undoId) });
	}, [jobQuery.data]); // eslint-disable-line react-hooks/exhaustive-deps

	const archive = (override?: Conversation[] | null) => run({ type: "archive" }, override);
	// Trash moves out of Trash only through Move to or Empty Trash.
	const canDelete = filter.view !== "trash";
	const remove = (override?: Conversation[] | null) => canDelete && run({ type: "trash" }, override);

	/** Read and Star toggle on whether every target already has the state. */
	const toggleFor = (kind: "read" | "star", override?: Conversation[] | null): BulkAction | null => {
		const targets = resolveTargets(override);
		if (!targets) return null;
		if (kind === "star") return starToggle(targets.rows);
		return readToggle(targets.rows, targets.patchKeys === null ? { unread: firstPage?.unread ?? 0 } : undefined);
	};
	const toggle = (kind: "read" | "star", override?: Conversation[] | null) => {
		const action = toggleFor(kind, override);
		if (action) run(action, override);
	};

	const openPicker = (from: "toolbar" | "bulk", rowsOverride: Conversation[] | null = null) => {
		if (picker) {
			setPicker(null);
			return;
		}
		if (!resolveTargets(rowsOverride)) return;
		setOpenPopover(null);
		setPicker({ rows: rowsOverride, from });
	};

	const pickerTargets = picker ? resolveTargets(picker.rows) : null;
	const pickerLabels: PickerLabel[] = useMemo(() => {
		if (!pickerTargets) return [];
		const inView = new Map((pickerFacets.data?.label ?? []).map((f) => [f.value, f.count]));
		return labelList.map((l) => ({
			...l,
			inView: inView.get(l.id),
			checked: pickerTargets.patchKeys === null
				? (inView.get(l.id) ?? 0) >= pickerTargets.count && pickerTargets.count > 0
				: pickerTargets.rows.every((r) => r.labels.includes(l.id)),
		}));
	}, [pickerTargets, pickerFacets.data, labelList]);

	const labelPicker = picker && pickerTargets ? (
		<LabelPicker
			labels={pickerLabels}
			targetCount={pickerTargets.count}
			busy={bulk.isPending || createLabel.isPending}
			onClose={() => setPicker(null)}
			onToggle={(label) => run({ type: label.checked ? "label_remove" : "label_add", labelId: label.id }, picker.rows, label.name)}
			onCreate={(name) => createLabel.mutate(
				{ name, color: LABEL_COLORS[labelList.length % LABEL_COLORS.length].bg },
				{
					onSuccess: (label) => run({ type: "label_add", labelId: label.id }, picker.rows, label.name),
					onError: (error) => showToast({ message: (error as Error).message }),
				},
			)}
			onArchive={() => {
				const rowsOverride = picker.rows;
				setPicker(null);
				archive(rowsOverride);
			}}
		/>
	) : null;

	const changeFilter = (next: MailFilter) => go(next, { open });
	const setView = (view: string) => {
		go({ view, chips: [], sort: filter.sort, dir: filter.dir }, { open });
		setSourcesOpen(false);
	};

	const onSearch = (event: FormEvent) => {
		event.preventDefault();
		if (!search.trim()) return;
		changeFilter(applySearch(filter, search, labelList));
		setSearch("");
	};

	const reply = () => {
		if (!open) return;
		const email = queryClient.getQueryData<Email>(queryKeys.emails.detail(open.mailboxId, open.emailId));
		if (email) startCompose({ mode: "reply", originalEmail: email });
	};

	const compose = () => {
		const address = singleAddress(filter);
		if (address) setComposeFrom(address);
		startCompose({ mode: "new" });
	};

	useMailShortcuts({
		next: () => move(1),
		previous: () => move(-1),
		search: () => searchRef.current?.focus(),
		keys: () => setKeysOpen((v) => !v),
		escape: () => {
			if (picker) setPicker(null);
			else if (openPopover) setOpenPopover(null);
			else if (sourcesOpen) setSourcesOpen(false);
			else {
				setKeysOpen(false);
				setSelection(sel.EMPTY_SELECTION);
			}
		},
		select: () => {
			if (activeKey && rowKeys.includes(activeKey)) setSelection((s) => sel.toggle(s, activeKey));
		},
		label: () => openPicker(selection.keys.size || selection.allMatching ? "bulk" : "toolbar"),
		archive: () => archive(),
		delete: () => remove(),
		star: () => toggle("star"),
		read: () => toggle("read"),
	});

	const selectedCount = sel.count(selection, total);
	const toolbarTargets = selection.keys.size > 0 || selection.allMatching || !!openRow;
	const readAction = toggleFor("read")?.type === "unread" ? "unread" : "read";
	const starAction = toggleFor("star")?.type === "unstar" ? "unstar" : "star";

	const toggleCompact = () => {
		setCompact((v) => {
			writeStorage(COMPACT_KEY, v ? "0" : "1");
			return !v;
		});
	};

	const agentMailbox = open?.mailboxId ?? singleAddress(filter) ?? agentPick;

	return (
		<div className={`mail-app${open || isComposing ? " has-reader" : ""}${isAgentPanelOpen ? " has-agent" : ""}`}>
			<TopBar
				filter={filter}
				labelNames={labelNames}
				addressCount={addresses.length}
				total={firstPage?.total}
				unread={firstPage?.unread}
				indexing={firstPage?.indexing ?? null}
				refreshing={list.isFetching && !list.isFetchingNextPage}
				agentOpen={isAgentPanelOpen}
				onRefresh={() => {
					queryClient.invalidateQueries({ queryKey: ["mail"] });
					queryClient.invalidateQueries({ queryKey: ["mail-facets"] });
				}}
				onToggleAgent={toggleAgentPanel}
				onToggleSources={() => setSourcesOpen((v) => !v)}
			/>
			<div className="mail-toolbar" role="toolbar" aria-label="Mail actions">
				<button type="button" className="mail-tool" onClick={compose}>
					<span className="mail-tool-icon"><PencilSimpleIcon size={15} /></span>
					<span className="mail-tool-label">Compose</span>
				</button>
				<button type="button" className="mail-tool" onClick={reply} disabled={!open}>
					<span className="mail-tool-icon"><ArrowBendUpLeftIcon size={15} /></span>
					<span className="mail-tool-label">Reply</span>
				</button>
				<button type="button" className="mail-tool" onClick={() => archive()} disabled={!toolbarTargets}>
					<span className="mail-tool-icon"><ArchiveIcon size={15} /></span>
					<span className="mail-tool-label">Archive</span>
				</button>
				<button type="button" className="mail-tool" onClick={() => remove()} disabled={!toolbarTargets || !canDelete}>
					<span className="mail-tool-icon"><TrashIcon size={15} /></span>
					<span className="mail-tool-label">Delete</span>
				</button>
				<button type="button" className="mail-tool" onClick={() => toggle("read")} disabled={!toolbarTargets}>
					<span className="mail-tool-icon">{readAction === "read" ? <EnvelopeOpenIcon size={15} /> : <EnvelopeSimpleIcon size={15} />}</span>
					<span className="mail-tool-label">{readAction === "read" ? "Read" : "Unread"}</span>
				</button>
				<button type="button" className="mail-tool" onClick={() => toggle("star")} disabled={!toolbarTargets}>
					<span className="mail-tool-icon"><StarIcon size={15} weight={starAction === "star" ? "regular" : "fill"} /></span>
					<span className="mail-tool-label">{starAction === "star" ? "Star" : "Unstar"}</span>
				</button>
				<div className="mail-tool-slot">
					<button
						type="button"
						className="mail-tool"
						data-label-anchor
						onClick={() => openPicker("toolbar")}
						disabled={!toolbarTargets}
						aria-expanded={picker?.from === "toolbar"}
					>
						<span className="mail-tool-icon"><TagIcon size={15} /></span>
						<span className="mail-tool-label">Label</span>
					</button>
					{picker?.from === "toolbar" && labelPicker}
				</div>
				<button type="button" className="mail-tool" onClick={toggleCompact} aria-pressed={compact}>
					<span className="mail-tool-icon"><RowsIcon size={15} /></span>
					<span className="mail-tool-label">Compact</span>
				</button>
				<button type="button" className="mail-tool" onClick={() => setKeysOpen((v) => !v)} aria-pressed={keysOpen}>
					<span className="mail-tool-icon"><KeyboardIcon size={15} /></span>
					<span className="mail-tool-label">Keys</span>
				</button>
				<form className="mail-search" onSubmit={onSearch} role="search">
					<MagnifyingGlassIcon size={14} aria-hidden />
					<input
						ref={searchRef}
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						onKeyDown={(e) => e.key === "Escape" && (setSearch(""), searchRef.current?.blur())}
						placeholder="from: to: subject: is:unread"
						aria-label="Search mail"
					/>
				</form>
			</div>
			{keysOpen && (
				<p className="mail-keys" aria-label="Keyboard shortcuts">
					<span><kbd>j</kbd><kbd>k</kbd> next, previous</span>
					<span><kbd>/</kbd> search</span>
					<span><kbd>x</kbd> select</span>
					<span><kbd>e</kbd> archive</span>
					<span><kbd>#</kbd> delete</span>
					<span><kbd>s</kbd> star</span>
					<span><kbd>u</kbd> read/unread</span>
					<span><kbd>l</kbd> label</span>
					<span><kbd>?</kbd> keys</span>
					<span><kbd>Esc</kbd> close</span>
				</p>
			)}
			{selectedCount > 0 ? (
				<BulkBar
					view={filter.view}
					count={selectedCount}
					total={total}
					allMatching={selection.allMatching}
					onClear={() => setSelection(sel.EMPTY_SELECTION)}
					onSelectAllMatching={() => setSelection((s) => sel.selectAllMatching(sel.selectAll(s, rowKeys)))}
					onArchive={() => archive()}
					onDelete={canDelete ? () => remove() : null}
					onRead={() => toggle("read")}
					readAction={readAction}
					onStar={() => toggle("star")}
					starAction={starAction}
					onLabel={() => openPicker("bulk")}
					labelOpen={picker?.from === "bulk"}
					onMove={(folder) => run({ type: "move", folder })}
					picker={picker?.from === "bulk" ? labelPicker : null}
				/>
			) : (
				<ScopeBar
					filter={filter}
					addresses={addresses}
					labels={labels}
					onChange={changeFilter}
					onFocusText={(text) => {
						setSearch(text);
						searchRef.current?.focus();
					}}
					openPopover={openPopover}
					setOpenPopover={setOpenPopover}
				>
					{filter.view === "trash" && (
						<EmptyTrash
							onMessage={(message) => showToast({ message })}
							onJob={(started) => {
								setJob({ ...started, message: "", action: { type: "empty_trash" } });
								showToast({ message: `Deleting ${started.total.toLocaleString()} messages.`, sticky: true });
							}}
							onDone={(deleted, failed) => {
								// Opened conversations stay listed until the filter changes; these are gone.
								setKept(new Map());
								go(filter, { replace: true, open: null });
								const failure = failed.length ? ` ${failed.length} address${failed.length === 1 ? "" : "es"} failed: ${failed[0].error}` : "";
								showToast({ message: `Deleted ${deleted.toLocaleString()} message${deleted === 1 ? "" : "s"} forever.${failure}` });
							}}
						/>
					)}
				</ScopeBar>
			)}
			<div className="mail-work">
				<SourceList
					view={filter.view}
					counts={counts}
					folders={folders}
					onView={setView}
					open={sourcesOpen}
					labels={labelList}
					activeLabels={chipValues(filter, "label")}
					onLabel={(id) => {
						const chip = { kind: "label" as const, value: id };
						const on = chipValues(filter, "label").includes(id);
						changeFilter({ ...filter, chips: on ? removeChip(filter.chips, chip) : addChip(filter.chips, chip) });
						setSourcesOpen(false);
					}}
				/>
				{sourcesOpen && <button type="button" className="mail-backdrop" aria-label="Close views" onClick={() => setSourcesOpen(false)} />}
				<section className="mail-main">
					<ConversationList
						rows={rows}
						total={Math.max(total, rows.length)}
						filter={filter}
						compact={compact}
						currentKey={activeKey}
						hasNextPage={!!list.hasNextPage}
						isFetchingNextPage={list.isFetchingNextPage}
						isPending={list.isPending}
						error={list.error}
						onOpen={(row) => openConversation(row)}
						onSort={(sort, dir) => go({ ...filter, sort, dir }, { replace: true })}
						fetchNextPage={() => list.fetchNextPage()}
						onRetry={() => list.refetch()}
						selection={selection}
						labels={labels}
						onCheck={(row, range) => setSelection((s) => (range ? sel.range(s, row.thread_key, rowKeys) : sel.toggle(s, row.thread_key)))}
						onCheckAll={(checked) => setSelection((s) => (checked ? sel.selectAll(s, rowKeys) : sel.EMPTY_SELECTION))}
						onArchive={(row) => archive([row])}
						onDelete={canDelete ? (row) => remove([row]) : null}
						onRead={(row) => toggle("read", [row])}
						onStar={(row) => toggle("star", [row])}
						onLabel={(row) => {
							setPicker(null);
							setOpenPopover(null);
							setPicker({ rows: [row], from: "toolbar" });
						}}
					/>
					<UnifiedReader
						open={open}
						autoOpened={!!openRow && openRow.thread_key === autoOpenedKey}
						state={openRow?.state}
						row={openRow}
						labels={labels}
						pickerOpen={!!picker && picker.rows?.[0]?.thread_key === openRow?.thread_key}
						onLabel={() => openPicker("toolbar", openRow ? [openRow] : null)}
						onRemoveLabel={(labelId) => openRow && run({ type: "label_remove", labelId }, [openRow], labels.get(labelId)?.name)}
						onRemoved={() => onRemoved()}
						onBack={() => go(filter, { replace: true, open: null })}
						composeFrom={composeFrom}
						setComposeFrom={setComposeFrom}
						addresses={addresses}
						idle={
							<>
								<img className="idle-stamp" src="/brand/app-icon.svg" alt="" width={88} height={88} />
								<p>Pick a conversation.</p>
							</>
						}
					/>
				</section>
				{isAgentPanelOpen && (
					<aside className="mail-agent" aria-label="Agent">
						{!open && !singleAddress(filter) && (
							<label className="mail-from">
								<span className="mail-caption">Agent for</span>
								<select value={agentPick} onChange={(e) => setAgentPick(e.target.value)}>
									{addresses.map((a) => <option key={a} value={a}>{a}</option>)}
								</select>
							</label>
						)}
						<AgentSidebar mailboxId={agentMailbox} />
					</aside>
				)}
			</div>
			<MailToast toast={toast} onClose={closeToast} />
		</div>
	);
}
