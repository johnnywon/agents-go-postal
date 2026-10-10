// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { ArchiveIcon, CaretDownIcon, CaretUpIcon, EnvelopeOpenIcon, EnvelopeSimpleIcon, PaperclipIcon, StarIcon, TagIcon, TrashIcon } from "@phosphor-icons/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useRef } from "react";
import { formatListDate } from "shared/dates";
import type { MailFilter } from "~/lib/mail-filter";
import type { Selection } from "~/lib/selection";
import type { Conversation, Label } from "~/services/api";
import { LabelChip } from "./LabelChip";

const ROW_HEIGHT = { two: 44, compact: 26 };

function senderOf(c: Conversation) {
	return c.sender_name || c.sender_addr || "(no sender)";
}

function SortButton({ label, sort, filter, onSort }: {
	label: string;
	sort: MailFilter["sort"];
	filter: MailFilter;
	onSort: (sort: MailFilter["sort"], dir: MailFilter["dir"]) => void;
}) {
	const active = filter.sort === sort;
	return (
		<button
			type="button"
			aria-pressed={active}
			aria-label={`Sort by ${label}${active ? (filter.dir === "asc" ? ", ascending" : ", descending") : ""}`}
			onClick={() => onSort(sort, active ? (filter.dir === "asc" ? "desc" : "asc") : sort === "date" ? "desc" : "asc")}
		>
			{label}
			{active && (filter.dir === "asc" ? <CaretUpIcon size={10} weight="bold" /> : <CaretDownIcon size={10} weight="bold" />)}
		</button>
	);
}

export default function ConversationList({
	rows, total, filter, compact, currentKey, hasNextPage, isFetchingNextPage, isPending, error,
	onOpen, onSort, fetchNextPage, onRetry, selection, labels, onCheck, onCheckAll, onArchive, onDelete, onRead, onStar, onLabel,
}: {
	selection: Selection;
	labels: ReadonlyMap<string, Label>;
	onCheck: (row: Conversation, range: boolean) => void;
	onCheckAll: (checked: boolean) => void;
	onArchive: (row: Conversation) => void;
	/** Null in the Trash view. */
	onDelete: ((row: Conversation) => void) | null;
	onRead: (row: Conversation) => void;
	onStar: (row: Conversation) => void;
	onLabel: (row: Conversation) => void;
	rows: Conversation[];
	total: number;
	filter: MailFilter;
	compact: boolean;
	currentKey: string | null;
	hasNextPage: boolean;
	isFetchingNextPage: boolean;
	isPending: boolean;
	error: unknown;
	onOpen: (row: Conversation) => void;
	onSort: (sort: MailFilter["sort"], dir: MailFilter["dir"]) => void;
	fetchNextPage: () => void;
	onRetry: () => void;
}) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: () => (compact ? ROW_HEIGHT.compact : ROW_HEIGHT.two),
		overscan: 12,
		getItemKey: (index) => rows[index]?.thread_key ?? index,
	});
	const items = virtualizer.getVirtualItems();
	const lastIndex = items.length ? items[items.length - 1].index : -1;

	useEffect(() => {
		virtualizer.measure();
	}, [compact, virtualizer]);

	useEffect(() => {
		if (hasNextPage && !isFetchingNextPage && lastIndex >= rows.length - 10) fetchNextPage();
	}, [lastIndex, rows.length, hasNextPage, isFetchingNextPage, fetchNextPage]);

	// Keep the current row in view when j/k moves it.
	const currentIndex = currentKey ? rows.findIndex((r) => r.thread_key === currentKey) : -1;
	useEffect(() => {
		if (currentIndex >= 0) virtualizer.scrollToIndex(currentIndex, { align: "auto" });
	}, [currentIndex, virtualizer]);

	const checkedLoaded = rows.filter((r) => selection.allMatching || selection.keys.has(r.thread_key)).length;
	const allChecked = rows.length > 0 && checkedLoaded === rows.length;
	const headerBox = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (headerBox.current) headerBox.current.indeterminate = checkedLoaded > 0 && !allChecked;
	}, [checkedLoaded, allChecked]);

	return (
		<div className="mail-list">
			<div className="mail-columns" role="toolbar" aria-label="Sort">
				<input
					ref={headerBox}
					type="checkbox"
					className="mail-check-box"
					checked={allChecked}
					disabled={rows.length === 0}
					onChange={(e) => onCheckAll(e.target.checked)}
					aria-label={allChecked ? "Clear selection" : "Select all loaded conversations"}
				/>
				<SortButton label="Sender" sort="from" filter={filter} onSort={onSort} />
				<SortButton label="Subject" sort="subject" filter={filter} onSort={onSort} />
				<SortButton label="Received" sort="date" filter={filter} onSort={onSort} />
			</div>
			<div ref={scrollRef} className="mail-list-scroll" id="mail-list" tabIndex={-1}>
				{isPending ? (
					<p className="mail-empty" role="status">Loading</p>
				) : error ? (
					<div className="mail-empty" role="alert">
						Could not load mail.
						<button type="button" className="mail-button" onClick={onRetry}>Try again</button>
					</div>
				) : rows.length === 0 ? (
					<p className="mail-empty">No match. Remove a chip.</p>
				) : (
					<div role="grid" aria-label="Conversations" aria-rowcount={total} style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
						{items.map((item) => {
							const c = rows[item.index];
							const current = c.thread_key === currentKey;
							const unread = c.thread_unread_count > 0;
							const checked = selection.allMatching || selection.keys.has(c.thread_key);
							const rowLabels = c.labels.map((id) => labels.get(id)).filter((l): l is Label => !!l);
							const who = senderOf(c);
							return (
								<div
									key={item.key}
									role="row"
									aria-rowindex={item.index + 1}
									aria-current={current ? "true" : undefined}
									aria-selected={checked}
									className={`mail-row${unread ? " is-unread" : ""}${compact ? " is-compact" : ""}${checked ? " is-checked" : ""}`}
									style={{ position: "absolute", top: 0, left: 0, right: 0, height: item.size, transform: `translateY(${item.start}px)` }}
								>
									{/* The whole cell is the touch target, not just the box. */}
									<label role="gridcell" className="mail-row-select">
										<input
											type="checkbox"
											className="mail-check-box"
											checked={checked}
											onChange={(e) => onCheck(c, (e.nativeEvent as MouseEvent).shiftKey === true)}
											aria-label={`Select ${who}: ${c.subject || "no subject"}`}
										/>
									</label>
									<button
										type="button"
										role="gridcell"
										className="mail-row-open"
										tabIndex={current || (!currentKey && item.index === 0) ? 0 : -1}
										onClick={() => onOpen(c)}
									>
										<span className="mail-row-line">
											<i className="mail-unread-dot" aria-label={unread ? "Unread" : undefined} />
											<b className="mail-row-sender">{who}</b>
											{c.thread_count > 1 && <em className="mail-row-count">{c.thread_count}</em>}
											{c.starred && <StarIcon size={12} weight="fill" className="mail-row-star" aria-label="Starred" />}
											{rowLabels.length > 0 && (
												<span className="mail-row-labels">
													{rowLabels.map((l) => <LabelChip key={l.id} label={l} />)}
												</span>
											)}
											{compact && <span className="mail-row-subject">{c.subject || "(no subject)"}</span>}
											<span className="mail-row-to" title={c.mailbox_id}>{c.mailbox_id}</span>
											<time dateTime={c.date}>{formatListDate(c.date)}</time>
										</span>
										{!compact && (
											<span className="mail-row-line mail-row-second">
												{c.has_attachment && <PaperclipIcon size={12} aria-label="Attachment" />}
												<span className="mail-row-subject">{c.subject || "(no subject)"}</span>
												{c.snippet && <span className="mail-row-snippet"> · {c.snippet}</span>}
											</span>
										)}
									</button>
									<span role="gridcell" className="mail-row-actions">
										<button type="button" className="mail-button" aria-label={`Archive ${who}`} title="Archive" onClick={() => onArchive(c)}>
											<ArchiveIcon size={13} />
										</button>
										{onDelete && (
											<button type="button" className="mail-button" aria-label={`Delete ${who}`} title="Delete" onClick={() => onDelete(c)}>
												<TrashIcon size={13} />
											</button>
										)}
										<button
											type="button"
											className="mail-button"
											aria-label={`Mark ${who} ${unread ? "read" : "unread"}`}
											title={unread ? "Mark read" : "Mark unread"}
											onClick={() => onRead(c)}
										>
											{unread ? <EnvelopeOpenIcon size={13} /> : <EnvelopeSimpleIcon size={13} />}
										</button>
										<button
											type="button"
											className="mail-button"
											aria-label={`${c.starred ? "Unstar" : "Star"} ${who}`}
											title={c.starred ? "Unstar" : "Star"}
											aria-pressed={c.starred}
											onClick={() => onStar(c)}
										>
											<StarIcon size={13} weight={c.starred ? "fill" : "regular"} />
										</button>
										<button type="button" className="mail-button" data-label-anchor aria-label={`Label ${who}`} title="Label" onClick={() => onLabel(c)}>
											<TagIcon size={13} />
										</button>
									</span>
								</div>
							);
						})}
					</div>
				)}
			</div>
			<div className="mail-footer">
				<span>Showing {rows.length.toLocaleString()} of {total.toLocaleString()}</span>
				{isFetchingNextPage && <span role="status">Loading more</span>}
			</div>
		</div>
	);
}
