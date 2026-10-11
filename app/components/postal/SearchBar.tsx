// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { ListIcon, MagnifyingGlassIcon, SparkleIcon, XIcon } from "@phosphor-icons/react";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { parseSearch } from "../../../shared/search-query";
import type { Conversation, FacetValue } from "~/services/api";
import type { Identities } from "./identity";
import {
	addRecent,
	appendTerm,
	applyCompletion,
	completionAt,
	completions,
	filterTerms,
	loadRecent,
	looksLikeRequest,
	removeRange,
	saveRecent,
	windowKey,
} from "./search-window";
import { type FilterSuggestion, rowDomId, SearchWindow, type WindowRow, type WindowSection } from "./SearchWindow";

export type { FilterSuggestion } from "./SearchWindow";

const MAX_RESULTS = 6;

export interface SearchBarProps {
	value: string;
	onChange: (value: string) => void;
	/** Enter with nothing highlighted: open the first result. */
	onOpenFirst: () => void;
	onOpenResult: (row: Conversation) => void;
	/** ↑↓ with the window closed move through the list. */
	onMove: (delta: number) => void;
	resultCount: number | null;
	/** The list's first conversations for the search. */
	results: Conversation[];
	/** The search text the results are for. */
	resultsFor: string;
	resultsLoading: boolean;
	terms: string[];
	/** An operator whose value doesn't parse. It is left out of the search. */
	error?: string;
	filters: FilterSuggestion[];
	/** Filters with counts for the current search. */
	narrow: FilterSuggestion[];
	addresses: { address: string; count?: number }[];
	/** Frequent senders, for People and `from:` completion. */
	people: FacetValue[];
	/** Senders and domains of the current search, for `from:` completion. */
	senders: FacetValue[];
	labels: { name: string; count: number }[];
	identities: Identities;
	/** Open the agent panel, with the text as the request when there is one. */
	onAsk: (text: string) => void;
	onMenu: () => void;
	onAgent: () => void;
	onFocusChange?: (focused: boolean) => void;
}

function storage(): Storage | undefined {
	try {
		return typeof window === "undefined" ? undefined : window.localStorage;
	} catch {
		return undefined;
	}
}

export const SearchBar = forwardRef<HTMLInputElement, SearchBarProps>(function SearchBar(props, ref) {
	const input = useRef<HTMLInputElement>(null);
	useImperativeHandle(ref, () => input.current as HTMLInputElement);
	const [focused, setFocused] = useState(false);
	const [dismissed, setDismissed] = useState(false);
	const [active, setActive] = useState<string | null>(null);
	const [cursor, setCursor] = useState(0);
	const [help, setHelp] = useState(false);
	const [recent, setRecent] = useState<string[]>([]);
	useEffect(() => setRecent(loadRecent(storage())), []);

	const text = props.value;
	const hasQ = text.trim().length > 0;
	const open = focused && !dismissed;

	const remember = (q: string) => {
		const next = addRecent(recent, q);
		setRecent(next);
		saveRecent(storage(), next);
	};
	const forget = (q: string) => {
		const next = recent.filter((s) => s !== q);
		setRecent(next);
		saveRecent(storage(), next);
	};
	const setText = (next: string, at = next.length) => {
		props.onChange(next);
		setActive(null);
		setCursor(at);
		requestAnimationFrame(() => input.current?.setSelectionRange(at, at));
	};
	const leave = () => input.current?.blur();

	const ctx = useMemo(() => completionAt(text, cursor), [text, cursor]);
	const sections = useMemo<WindowSection[]>(() => {
		const out: WindowSection[] = [];
		const filterRow = (f: FilterSuggestion, section: string): WindowRow => ({
			id: `${section}:${f.token}`, kind: "filter", filter: f, choose: () => setText(appendTerm(text, f.token)),
		});
		if (ctx) {
			const list = completions(ctx, {
				addresses: props.addresses.map((a) => a.address),
				senders: dedupe([...props.senders, ...props.people]),
				labels: props.labels,
				now: new Date(),
			});
			if (list.length) {
				out.push({
					id: "complete",
					title: ctx.kind === "operator" ? "Operators" : "Complete",
					rows: list.map((c) => ({
						id: `c:${c.insert}`, kind: "completion", completion: c,
						choose: () => {
							const r = applyCompletion(text, ctx, c.insert);
							setText(r.text, r.cursor);
						},
					})),
				});
			}
		}
		if (!hasQ) {
			if (recent.length) {
				out.push({
					id: "recent", title: "Recent",
					rows: recent.map((q) => ({ id: `r:${q}`, kind: "recent", text: q, remove: () => forget(q), choose: () => setText(`${q} `) })),
				});
			}
			if (props.people.length) {
				out.push({
					id: "people", title: "People",
					rows: props.people.slice(0, 6).map((p) => ({
						id: `p:${p.value}`, kind: "person", address: p.value, name: p.name, count: p.count,
						choose: () => setText(appendTerm(text, `from:${p.value}`)),
					})),
				});
			}
			out.push({ id: "filters", title: "Filters", side: true, rows: props.filters.map((f) => filterRow(f, "f")) });
			out.push({
				id: "addresses", title: "Addresses", side: true,
				rows: props.addresses.map((a) => ({
					id: `a:${a.address}`, kind: "address", address: a.address, count: a.count,
					choose: () => setText(appendTerm(text, `to:${a.address}`)),
				})),
			});
			out.push({
				id: "ask", title: "Ask", side: true,
				rows: [{ id: "ask", kind: "action", icon: "ask", label: "Ask the agent…", choose: () => { leave(); props.onAsk(""); } }],
			});
			return out;
		}

		const current = props.resultsFor.trim() === text.trim();
		if (props.results.length) {
			out.push({
				id: "results", title: "Top results",
				rows: props.results.slice(0, MAX_RESULTS).map((row) => ({
					id: `m:${row.thread_key}`, kind: "result", row,
					choose: () => {
						remember(text);
						leave();
						props.onOpenResult(row);
					},
				})),
			});
		} else if (current && !props.resultsLoading && props.resultCount === 0) {
			const query = parseSearch(text);
			const rows: WindowRow[] = [];
			if (!query.terms.some((t) => t.any.some((l) => l.type === "op" && l.op === "in" && l.value === "anywhere"))) {
				rows.push({ id: "everywhere", kind: "action", icon: "everywhere", label: "Search everywhere", detail: "in:anywhere", choose: () => setText(appendTerm(text, "in:anywhere")) });
			}
			for (const t of filterTerms(text).slice(0, 3)) {
				rows.push({ id: `rm:${t.start}`, kind: "action", icon: "remove", label: `Remove ${t.text}`, choose: () => setText(`${removeRange(text, t.start, t.end)} `) });
			}
			if (rows.length) out.push({ id: "nothing", title: "No results", rows });
		}
		const typed = text.toLowerCase();
		const narrow = props.narrow.filter((f) => !typed.includes(f.token.toLowerCase()));
		if (narrow.length) out.push({ id: "narrow", title: "Narrow", side: true, rows: narrow.map((f) => filterRow(f, "n")) });
		if (looksLikeRequest(text)) {
			out.push({
				id: "ask", title: "Ask", side: true,
				rows: [{
					id: "ask", kind: "action", icon: "ask", label: `Ask: "${text.trim()}"`,
					choose: () => {
						remember(text);
						leave();
						props.onAsk(text.trim());
					},
				}],
			});
		}
		return out;
	}, [ctx, text, hasQ, recent, props.people, props.senders, props.filters, props.addresses, props.labels, props.narrow, props.results, props.resultsFor, props.resultsLoading, props.resultCount]); // eslint-disable-line react-hooks/exhaustive-deps

	// Keyboard order: the wide column, then the side column.
	const rows = useMemo(() => [...sections.filter((s) => !s.side), ...sections.filter((s) => s.side)].flatMap((s) => s.rows), [sections]);
	const activeIndex = active ? rows.findIndex((r) => r.id === active) : -1;
	// A highlighted row that left the window is no longer highlighted.
	useEffect(() => {
		if (active && activeIndex < 0) setActive(null);
	}, [active, activeIndex]);
	useEffect(() => {
		if (active) document.getElementById(rowDomId(active))?.scrollIntoView({ block: "nearest" });
	}, [active]);

	const show = open && (help || rows.length > 0);
	const completing = sections[0]?.id === "complete";

	const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		const action = windowKey(
			{ key: e.key, meta: e.metaKey, ctrl: e.ctrlKey, shift: e.shiftKey },
			{ open: show, active: activeIndex, rows: help ? 0 : rows.length, completing: completing && !help, hasText: !!text },
		);
		if (!action) return;
		e.preventDefault();
		switch (action.type) {
			case "close":
				setDismissed(true);
				setHelp(false);
				return;
			case "clear": setText(""); return;
			case "blur": leave(); return;
			case "reopen": setDismissed(false); return;
			case "highlight": setActive(action.active >= 0 ? rows[action.active].id : null); return;
			case "list": props.onMove(action.delta); return;
			case "complete": (activeIndex >= 0 && rows[activeIndex].kind === "completion" ? rows[activeIndex] : sections[0].rows[0]).choose(); return;
			case "choose": rows[activeIndex]?.choose(); return;
			case "run":
				remember(text);
				leave();
				return;
			case "openFirst":
				remember(text);
				props.onOpenFirst();
				leave();
				return;
		}
	};
	const syncCursor = (e: React.SyntheticEvent<HTMLInputElement>) => setCursor(e.currentTarget.selectionStart ?? e.currentTarget.value.length);
	const announced = hasQ && props.resultCount !== null && props.resultsFor.trim() === text.trim();

	return (
		<div className="pg-search-wrap">
			<div className="pg-search" data-suggest={show} data-active={hasQ || focused} role="search">
				<button type="button" className="pg-icon-btn pg-mobile-only" onClick={props.onMenu} aria-label="Open menu">
					<ListIcon size={16} />
				</button>
				<MagnifyingGlassIcon size={14} className="pg-search-icon" aria-hidden />
				<input
					ref={input}
					value={text}
					onChange={(e) => {
						props.onChange(e.target.value);
						setActive(null);
						setDismissed(false);
						setHelp(false);
						syncCursor(e);
					}}
					onSelect={syncCursor}
					onFocus={() => {
						setFocused(true);
						setDismissed(false);
						props.onFocusChange?.(true);
					}}
					onBlur={() => {
						setFocused(false);
						setActive(null);
						setHelp(false);
						props.onFocusChange?.(false);
					}}
					onKeyDown={onKeyDown}
					placeholder="Search mail — try  from:stripe  is:unread  has:attachment"
					spellCheck={false}
					autoComplete="off"
					aria-label="Search mail"
					aria-expanded={show}
					aria-controls="pg-sw"
					aria-autocomplete="list"
					aria-activedescendant={show && active ? rowDomId(active) : undefined}
					role="combobox"
				/>
				{hasQ && (
					<>
						{props.error ? (
							<span className="pg-search-error pg-ellipsis" role="status" title={props.error}>{props.error}</span>
						) : props.resultCount !== null && (
							<span className="pg-result-count">{props.resultCount.toLocaleString()} result{props.resultCount === 1 ? "" : "s"}</span>
						)}
						<button type="button" className="pg-clear" title="Clear search (Esc)" aria-label="Clear search" onMouseDown={(e) => { e.preventDefault(); setText(""); }}>
							<XIcon size={14} />
						</button>
					</>
				)}
				<img className="deck-brand-logo pg-watermark" src="/brand/logo.svg" alt="" aria-hidden="true" />
				<span className="pg-kbd pg-desktop-only">/</span>
				<button type="button" className="pg-icon-btn pg-mobile-only" onClick={props.onAgent} aria-label="Open agent">
					<SparkleIcon size={16} weight="fill" />
				</button>
			</div>
			<span className="pg-sr-only" aria-live="polite">
				{announced ? `${props.resultCount} result${props.resultCount === 1 ? "" : "s"}` : ""}
			</span>
			{show && (
				<SearchWindow
					sections={sections}
					active={active}
					terms={props.terms}
					identities={props.identities}
					stale={props.resultsFor.trim() !== text.trim()}
					help={help}
					onHelp={setHelp}
					onHover={setActive}
				/>
			)}
		</div>
	);
});

/** One entry per sender, keeping the higher count and any name. */
function dedupe(list: FacetValue[]): FacetValue[] {
	const seen = new Map<string, FacetValue>();
	for (const f of list) {
		const key = f.value.toLowerCase();
		const prev = seen.get(key);
		if (!prev || f.count > prev.count) seen.set(key, { ...f, name: f.name ?? prev?.name });
	}
	return [...seen.values()];
}
