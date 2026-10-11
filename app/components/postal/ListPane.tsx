// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	ArchiveIcon, ArrowsClockwiseIcon, CaretDownIcon, ChatsCircleIcon, CheckIcon, ClockIcon, EnvelopeOpenIcon, EnvelopeSimpleIcon,
	FileIcon, FunnelSimpleIcon, MagnifyingGlassIcon, PaperclipIcon, PaperPlaneTiltIcon, PencilSimpleLineIcon, SortAscendingIcon,
	SortDescendingIcon, StarIcon, TagIcon, TrashIcon, TrayIcon, WarningIcon, XIcon,
} from "@phosphor-icons/react";
import { Fragment, useEffect, useRef, useState } from "react";
import type { MailFilter } from "~/lib/mail-filter";
import type { Conversation, Label, MailFacets, ScheduledSend } from "~/services/api";
import { AddressText, type Identities, Swatch } from "./identity";
import { dayKey, dayLabel, filterCount, hasChip, highlight, labelOf, scopeOf, sendTimeLabel, timeLabel, toggleChip, withoutKinds } from "./model";

export interface ListPaneProps {
	identities: Identities;
	filter: MailFilter;
	go: (filter: MailFilter) => void;
	title: string;
	searching: boolean;
	allUnread?: number;
	unreadByAddress: ReadonlyMap<string, number>;
	onNew: () => void;
	onRefresh: () => void;
	refreshing: boolean;
	facets?: MailFacets;
	onFacets: (open: boolean) => void;
	labels: Label[];
	labelsById: ReadonlyMap<string, Label>;
	rows: Conversation[];
	total: number;
	loading: boolean;
	error: Error | null;
	onRetry: () => void;
	hasNextPage: boolean;
	fetchingNext: boolean;
	fetchNext: () => void;
	currentKey: string | null;
	onOpen: (row: Conversation) => void;
	checked: ReadonlySet<string>;
	onCheck: (row: Conversation, range: boolean) => void;
	onSelectAll: () => void;
	onClearSelection: () => void;
	onRowAction: (row: Conversation, action: "archive" | "star" | "read" | "trash") => void;
	onBulk: (action: "archive" | "read" | "star" | "trash") => void;
	terms: string[];
	scheduled: ReadonlyMap<string, ScheduledSend>;
	onCancelScheduled: (s: ScheduledSend) => void;
	onClearSearch: () => void;
	onHome: () => void;
}

const EMPTY: Record<string, { Icon: typeof TrayIcon; title: string; body: string }> = {
	drafts: { Icon: FileIcon, title: "No drafts", body: "Drafts you or the agent start show up here until they're sent." },
	sent: { Icon: PaperPlaneTiltIcon, title: "Nothing sent yet", body: "Mail you send from any address appears here, with the address it went out from." },
	archive: { Icon: ArchiveIcon, title: "Archive is empty", body: "Press E on any message to archive it. You can undo." },
	spam: { Icon: WarningIcon, title: "No spam", body: "Nothing suspicious has arrived." },
	trash: { Icon: TrashIcon, title: "Trash is empty", body: "Anything you delete lands here first." },
	starred: { Icon: StarIcon, title: "No starred mail", body: "Star a conversation to keep it here." },
};

function Highlighted({ text, terms }: { text: string; terms: string[] }) {
	const [a, b, c] = highlight(text, terms);
	return <>{a}{b && <mark>{b}</mark>}{c}</>;
}

export function ListPane(props: ListPaneProps) {
	const { identities, filter, go, rows } = props;
	const scope = scopeOf(filter);
	const labelView = labelOf(filter);
	const [scopeOpen, setScopeOpen] = useState(false);
	const [fltOpen, setFltOpen] = useState(false);
	const sentinel = useRef<HTMLDivElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const unreadOnly = hasChip(filter, "is", "unread");
	const nFilters = filterCount(filter);

	useEffect(() => props.onFacets(fltOpen), [fltOpen]); // eslint-disable-line react-hooks/exhaustive-deps

	// Load the next page when the end of the list scrolls into view.
	useEffect(() => {
		const el = sentinel.current;
		if (!el || !props.hasNextPage) return;
		const io = new IntersectionObserver((entries) => {
			if (entries.some((e) => e.isIntersecting) && !props.fetchingNext) props.fetchNext();
		}, { root: listRef.current, rootMargin: "400px" });
		io.observe(el);
		return () => io.disconnect();
	}, [props.hasNextPage, props.fetchingNext, props.fetchNext]); // eslint-disable-line react-hooks/exhaustive-deps

	// Keep the open row in view as j/k move.
	useEffect(() => {
		if (!props.currentKey || !listRef.current) return;
		const el = listRef.current.querySelector<HTMLElement>(`[data-key="${CSS.escape(props.currentKey)}"]`);
		el?.scrollIntoView({ block: "nearest" });
	}, [props.currentKey]);

	const pickScope = (value: string | null) => {
		setScopeOpen(false);
		go({ view: "inbox", chips: value ? [{ kind: "address", value }] : [], sort: filter.sort, dir: filter.dir });
	};

	const scopeIcon = labelView ? (
		<TagIcon size={14} weight="fill" color="var(--pg-text-5)" />
	) : scope ? (
		<Swatch identity={identities.of(scope)} />
	) : (
		<TrayIcon size={14} weight="fill" className="pg-tray" />
	);

	const status = props.facets?.status;
	const labelFacet = new Map((props.facets?.label ?? []).map((f) => [f.value, f.count]));
	const dateChip = filter.chips.find((c) => c.kind === "date")?.value ?? "any";
	const setDate = (value: string) => {
		const base = withoutKinds(filter, ["date"]);
		go(value === "any" ? base : { ...base, chips: [...base.chips, { kind: "date", value }] });
	};
	const clearFilters = () => {
		const keep = filter.chips.filter((c, i) => {
			if (c.kind === "is" && c.value === "unread") return true;
			if (c.kind === "label" && labelView === c.value && i === 0) return true;
			return !["is", "has", "label", "date"].includes(c.kind);
		});
		go({ ...filter, chips: keep });
	};

	const empty = props.searching
		? { Icon: MagnifyingGlassIcon, title: "No results", body: "Try fewer words, or a filter like from:, to: or label:." }
		: EMPTY[filter.view] ?? (unreadOnly
			? { Icon: TrayIcon, title: "No unread mail", body: "Everything here has been read." }
			: { Icon: TrayIcon, title: "Nothing here", body: "No messages match this view." });

	let lastDay: string | null = null;
	const groupByDay = filter.sort === "date";
	const selecting = props.checked.size > 0;

	return (
		<section className="pg-list-col" aria-label="Conversations">
			<div className="pg-list-head">
				<button type="button" className="pg-scope-btn" onClick={() => setScopeOpen((v) => !v)} title="Switch mailbox" aria-expanded={scopeOpen} aria-haspopup="listbox">
					<span className="pg-scope-icon">{scopeIcon}</span>
					<span className="pg-title">{props.title}</span>
					<CaretDownIcon size={10} weight="bold" color="var(--pg-text-6)" style={{ flex: "none" }} />
				</button>
				{scopeOpen && (
					<>
						<div className="pg-scrim-click" onClick={() => setScopeOpen(false)} />
						<div className="pg-popover pg-scope-menu" role="listbox" aria-label="Mailbox">
							<button type="button" role="option" aria-selected={!scope} className="pg-menu-item" aria-current={!scope || undefined} onClick={() => pickScope(null)}>
								<TrayIcon size={14} weight="fill" className="pg-tray" style={{ flex: "none" }} />
								<span className="pg-flex pg-ellipsis" style={{ fontWeight: 500, color: "var(--pg-text-2)" }}>All inboxes</span>
								<span className="pg-count" style={{ fontWeight: 400 }}>{props.allUnread || ""}</span>
								{!scope && <CheckIcon size={12} weight="bold" />}
							</button>
							{identities.groups.map(({ identity, addresses }) => (
								<Fragment key={identity.domain}>
									<button type="button" role="option" aria-selected={scope === identity.domain} className="pg-menu-item" aria-current={scope === identity.domain || undefined} onClick={() => pickScope(identity.domain)}>
										<Swatch identity={identity} />
										<span className="pg-flex pg-ellipsis" style={{ fontWeight: 500, color: "var(--pg-text-3)" }}>{identity.domain}</span>
										<span className="pg-count" style={{ fontWeight: 400 }}>
											{[...props.unreadByAddress.entries()].reduce((s, [a, n]) => (a.endsWith(`@${identity.domain}`) ? s + n : s), 0) || ""}
										</span>
										{scope === identity.domain && <CheckIcon size={12} weight="bold" />}
									</button>
									{addresses.map((address) => (
										<button key={address} type="button" role="option" aria-selected={scope === address} className="pg-menu-item" style={{ paddingLeft: 27 }} aria-current={scope === address || undefined} onClick={() => pickScope(address)}>
											<span className="pg-flex pg-ellipsis"><AddressText address={address} identity={identity} bold={false} /></span>
											<span className="pg-count" style={{ fontWeight: 400 }}>{props.unreadByAddress.get(address) || ""}</span>
											{scope === address && <CheckIcon size={12} weight="bold" />}
										</button>
									))}
								</Fragment>
							))}
						</div>
					</>
				)}
				<div style={{ flex: 1, minWidth: 4 }} />
				<button type="button" className="pg-new-btn" onClick={props.onNew} title="New email (C)" aria-label="New email">
					<PencilSimpleLineIcon size={16} />
				</button>
				<div className="pg-group">
					<button
						type="button"
						className="pg-icon-btn"
						aria-pressed={unreadOnly}
						title={unreadOnly ? "Showing unread only — show all" : "Show unread only"}
						onClick={() => go(toggleChip(filter, { kind: "is", value: "unread" }))}
					>
						<EnvelopeSimpleIcon size={16} weight={unreadOnly ? "fill" : "regular"} />
					</button>
					<button type="button" className="pg-icon-btn" style={{ position: "relative" }} aria-pressed={nFilters > 0} aria-expanded={fltOpen} title="Filter" onClick={() => setFltOpen((v) => !v)}>
						<FunnelSimpleIcon size={16} weight={nFilters ? "fill" : "regular"} />
						{nFilters > 0 && <span className="pg-flt-badge">{nFilters}</span>}
					</button>
					<button
						type="button"
						className="pg-icon-btn pg-wide-only"
						title={filter.dir === "asc" ? "Oldest first" : "Newest first"}
						onClick={() => go({ ...filter, sort: "date", dir: filter.dir === "asc" ? "desc" : "asc" })}
					>
						{filter.dir === "asc" ? <SortAscendingIcon size={16} /> : <SortDescendingIcon size={16} />}
					</button>
					<button type="button" className="pg-icon-btn pg-wide-only" title="Refresh" aria-label="Refresh" onClick={props.onRefresh} disabled={props.refreshing}>
						<ArrowsClockwiseIcon size={16} />
					</button>
				</div>
				{fltOpen && (
					<>
						<div className="pg-scrim-click" onClick={() => setFltOpen(false)} />
						<div className="pg-popover pg-flt-menu" role="dialog" aria-label="Filter" data-mail-popover>
							<div className="pg-flt-scroll">
								<span className="pg-caption">STATUS</span>
								{([
									["is", "unread", "Unread", EnvelopeSimpleIcon, status?.unread],
									["is", "starred", "Starred", StarIcon, status?.starred],
									["has", "attachment", "Has attachment", PaperclipIcon, status?.attachment],
								] as const).map(([kind, value, label, Icon, n]) => {
									const on = hasChip(filter, kind, value);
									return (
										<button key={value} type="button" role="menuitemcheckbox" aria-checked={on} className="pg-menu-item" onClick={() => go(toggleChip(filter, { kind, value }))}>
											<span className="pg-check pg-check-neutral" data-on={on}>{on && <CheckIcon size={10} weight="bold" />}</span>
											<Icon size={14} color="var(--pg-text-6)" style={{ flex: "none" }} />
											<span className="pg-flex pg-ellipsis">{label}</span>
											<span className="pg-count" style={{ fontWeight: 400 }}>{n ?? ""}</span>
										</button>
									);
								})}
								{/* TODO(roadmap): "Needs you" status and the "Handled by rule" section return with rules. */}
								{props.labels.length > 0 && <span className="pg-caption">LABELS</span>}
								{props.labels.map((label) => {
									const on = hasChip(filter, "label", label.id);
									return (
										<button key={label.id} type="button" role="menuitemcheckbox" aria-checked={on} className="pg-menu-item" onClick={() => go(toggleChip(filter, { kind: "label", value: label.id }))}>
											<span className="pg-check pg-check-neutral" data-on={on}>{on && <CheckIcon size={10} weight="bold" />}</span>
											<TagIcon size={14} color="var(--pg-text-6)" style={{ flex: "none" }} />
											<span className="pg-flex pg-ellipsis">{label.name}</span>
											<span className="pg-count" style={{ fontWeight: 400 }}>{labelFacet.get(label.id) ?? ""}</span>
										</button>
									);
								})}
								<span className="pg-caption">RECEIVED</span>
								<div className="pg-flt-dates">
									{([["any", "Any"], ["today", "Today"], ["7d", "7 days"], ["30d", "30 days"]] as const).map(([value, label]) => (
										<button key={value} type="button" aria-pressed={dateChip === value} onClick={() => setDate(value)}>{label}</button>
									))}
								</div>
							</div>
							<div className="pg-flt-foot">
								<span className="pg-match">{props.total.toLocaleString()} match{props.total === 1 ? "" : "es"}</span>
								<button type="button" className="pg-btn pg-btn-sm pg-btn-quiet" onClick={clearFilters}>Clear</button>
								<button type="button" className="pg-btn pg-btn-sm" style={{ fontWeight: 600, background: "var(--pg-hover-raised)" }} onClick={() => setFltOpen(false)}>Done</button>
							</div>
						</div>
					</>
				)}
			</div>
			<div className="pg-list" ref={listRef} data-selecting={selecting}>
				{props.loading && Array.from({ length: 6 }, (_, i) => (
					<div key={i} className="pg-skel" aria-hidden>
						<div style={{ width: 64, flex: "none", display: "flex", flexDirection: "column", gap: 6 }}>
							<span className="pg-pulse" style={{ width: 40 }} />
							<span style={{ width: 30 }} />
						</div>
						<div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 7 }}>
							<span className="pg-pulse" style={{ width: "45%" }} />
							<span className="pg-pulse" style={{ width: "80%", height: 9 }} />
							<span style={{ width: "95%" }} />
						</div>
					</div>
				))}
				{!props.loading && props.error && (
					<div className="pg-empty">
						<div className="pg-empty-icon"><WarningIcon size={20} /></div>
						<h2>Could not load mail</h2>
						<p>{props.error.message}</p>
						<button type="button" className="pg-btn" onClick={props.onRetry}>Retry</button>
					</div>
				)}
				{!props.loading && !props.error && rows.length === 0 && (
					<div className="pg-empty">
						<div className="pg-empty-icon"><empty.Icon size={20} /></div>
						<h2>{empty.title}</h2>
						<p>{empty.body}</p>
						<button type="button" className="pg-btn" onClick={props.searching ? props.onClearSearch : props.onHome}>
							{props.searching ? "Clear search" : "Back to All inboxes"}
							<span className="pg-keyhint pg-mono" style={{ fontSize: 10, color: "var(--pg-text-8)" }}>G I</span>
						</button>
					</div>
				)}
				{!props.loading && rows.map((row) => {
					const day = dayKey(row.date);
					const dayStart = day !== lastDay;
					const gap = groupByDay && dayStart && lastDay !== null;
					lastDay = day;
					const checked = props.checked.has(row.thread_key);
					const sched = row.state === "draft" ? props.scheduled.get(row.email_id) : undefined;
					const identity = identities.of(row.mailbox_id);
					const rowLabels = row.labels.map((id) => props.labelsById.get(id)).filter((l): l is Label => !!l);
					return (
						<Fragment key={row.thread_key}>
							{gap && <div className="pg-gap" aria-hidden />}
							<div
								className="pg-row"
								role="button"
								tabIndex={0}
								data-key={row.thread_key}
								data-unread={row.unread && row.state !== "draft"}
								data-checked={checked || undefined}
								aria-current={props.currentKey === row.thread_key || undefined}
								aria-label={`${row.unread ? "Unread. " : ""}${row.sender_name || row.sender_addr}: ${row.subject || "(no subject)"}`}
								onClick={(e) => {
									if (e.shiftKey && selecting) props.onCheck(row, true);
									else props.onOpen(row);
								}}
								onKeyDown={(e) => {
									if (e.key === "Enter" && e.target === e.currentTarget) props.onOpen(row);
								}}
							>
								<div className="pg-row-when">
									<span className={groupByDay && dayStart ? "pg-day-first" : undefined}>{dayLabel(row.date)}</span>
									<span>{timeLabel(row.date)}</span>
									<div className="pg-spacer" />
									<div className="pg-row-glyphs">
										{row.starred && <StarIcon size={12} weight="fill" className="pg-star" aria-label="Starred" />}
										{row.has_attachment && <PaperclipIcon size={12} aria-label="Attachment" />}
										{row.thread_count > 1 && (
											<span className="pg-thread" title="Messages in thread">
												<ChatsCircleIcon size={12} />{row.thread_count}
											</span>
										)}
									</div>
								</div>
								<div className="pg-row-main">
									<div className="pg-row-to" title={`Delivered to ${row.mailbox_id} — replies send from here`}>
										<Swatch identity={identity} />
										<AddressText address={row.mailbox_id} identity={identity} />
										{row.also_in.length > 0 && <span className="pg-also">+{row.also_in.length}</span>}
									</div>
									<div className="pg-row-sender">{row.state === "draft" ? "Draft" : row.sender_name || row.sender_addr}</div>
									<div className="pg-row-subject"><Highlighted text={row.subject || "(no subject)"} terms={props.terms} /></div>
									{row.snippet && <div className="pg-row-preview"><Highlighted text={row.snippet} terms={props.terms} /></div>}
									{/* TODO(roadmap): rule chips on rows (Inquiry, Receipts, DMARC, Triage with their icons) return with rules. */}
									{(rowLabels.length > 0 || sched) && (
										<div className="pg-row-labels">
											{sched && (
												<span className="pg-row-badge" data-error={!!sched.error || undefined} title={sched.error ?? undefined} onClick={(e) => e.stopPropagation()}>
													<ClockIcon size={10} />
													{sched.error ? "Send failed" : `Scheduled · ${sendTimeLabel(new Date(sched.sendAt))}`}
													<button type="button" onClick={() => props.onCancelScheduled(sched)}>Cancel</button>
												</span>
											)}
											{rowLabels.map((l) => (
												<span key={l.id} className="pg-label-chip"><TagIcon size={10} />{l.name}</span>
											))}
										</div>
									)}
								</div>
								<div className="pg-row-tools" onClick={(e) => e.stopPropagation()}>
									<button type="button" title="Select (X) · shift-click for a range" aria-label="Select" aria-pressed={checked} onClick={(e) => props.onCheck(row, e.shiftKey)}>
										<span className="pg-check" data-on={checked}>{checked && <CheckIcon size={10} weight="bold" />}</span>
									</button>
									<span className="pg-sep" />
									<button type="button" title="Archive (E)" aria-label="Archive" onClick={() => props.onRowAction(row, "archive")}><ArchiveIcon size={15} /></button>
									<button type="button" title={row.starred ? "Unstar" : "Star"} aria-label={row.starred ? "Unstar" : "Star"} onClick={() => props.onRowAction(row, "star")}>
										<StarIcon size={15} weight={row.starred ? "fill" : "regular"} />
									</button>
									<button type="button" title={row.unread ? "Mark read" : "Mark unread"} aria-label={row.unread ? "Mark read" : "Mark unread"} onClick={() => props.onRowAction(row, "read")}>
										{row.unread ? <EnvelopeOpenIcon size={15} /> : <EnvelopeSimpleIcon size={15} />}
									</button>
									{filter.view !== "trash" && (
										<button type="button" title="Move to trash" aria-label="Move to trash" onClick={() => props.onRowAction(row, "trash")}><TrashIcon size={15} /></button>
									)}
								</div>
								<div className="pg-row-checkonly" onClick={(e) => e.stopPropagation()}>
									<button type="button" title="Select (X) · shift-click for a range" aria-label="Select" aria-pressed={checked} onClick={(e) => props.onCheck(row, e.shiftKey)}>
										<span className="pg-check" data-on={checked}>{checked && <CheckIcon size={10} weight="bold" />}</span>
									</button>
								</div>
							</div>
						</Fragment>
					);
				})}
				{props.hasNextPage && <div ref={sentinel} className="pg-more">{props.fetchingNext ? <span className="pg-count">Loading…</span> : null}</div>}
				{selecting && (
					<div className="pg-bulk">
						<div className="pg-bulk-bar" role="toolbar" aria-label="Selected conversations">
							<span className="pg-sel-count">{props.checked.size} selected</span>
							<button type="button" className="pg-all" onClick={props.onSelectAll}>All</button>
							<div style={{ flex: 1 }} />
							<button type="button" className="pg-tool" title="Archive" aria-label="Archive" onClick={() => props.onBulk("archive")}><ArchiveIcon size={15} /></button>
							<button type="button" className="pg-tool" title="Read" aria-label="Mark read" onClick={() => props.onBulk("read")}><EnvelopeOpenIcon size={15} /></button>
							<button type="button" className="pg-tool" title="Star" aria-label="Star" onClick={() => props.onBulk("star")}><StarIcon size={15} /></button>
							{filter.view !== "trash" && <button type="button" className="pg-tool" title="Trash" aria-label="Move to trash" onClick={() => props.onBulk("trash")}><TrashIcon size={15} /></button>}
							<span className="pg-sep" />
							<button type="button" className="pg-tool" title="Clear selection (Esc)" aria-label="Clear selection" onClick={props.onClearSelection} style={{ color: "var(--pg-text-6)" }}><XIcon size={14} /></button>
						</div>
					</div>
				)}
			</div>
		</section>
	);
}
