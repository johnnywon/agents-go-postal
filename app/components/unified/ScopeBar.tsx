// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { CaretDownIcon, CheckIcon, MagnifyingGlassIcon, XIcon } from "@phosphor-icons/react";
import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useDirectoryPrefs } from "~/hooks/useDirectoryPrefs";
import {
	addChip,
	type Chip,
	chipLabel,
	DATE_LABELS,
	DATE_TOKENS,
	type MailFilter,
	removeChip,
} from "~/lib/mail-filter";
import { useMailFacets } from "~/queries/mail";
import type { Label, MailFacets } from "~/services/api";
import { LabelSwatch } from "./LabelChip";

export type PopoverKind = "address" | "from" | "label" | "date" | "status";

interface Item {
	key: string;
	chip: Chip;
	label: string;
	count?: number;
	indent?: boolean;
	heading?: boolean;
	color?: string;
}

const POPOVER_FOR: Partial<Record<Chip["kind"], PopoverKind>> = {
	address: "address", from: "from", label: "label", date: "date", is: "status", has: "status",
};

const STATUS_ITEMS: { chip: Chip; label: string; facet: keyof MailFacets["status"] }[] = [
	{ chip: { kind: "is", value: "unread" }, label: "Unread", facet: "unread" },
	{ chip: { kind: "is", value: "read" }, label: "Read", facet: "read" },
	{ chip: { kind: "is", value: "starred" }, label: "Starred", facet: "starred" },
	{ chip: { kind: "has", value: "attachment" }, label: "Attachment", facet: "attachment" },
	{ chip: { kind: "has", value: "unsubscribe" }, label: "Can unsubscribe", facet: "unsubscribe" },
];

const TITLES: Record<PopoverKind, string> = { address: "Address", from: "From", label: "Label", date: "Date", status: "Status" };

function hasChip(filter: MailFilter, chip: Chip) {
	return filter.chips.some((c) => c.kind === chip.kind && c.value === chip.value);
}

function domainOf(address: string) {
	return address.slice(address.lastIndexOf("@") + 1);
}

function addressItems(addresses: string[], facets: MailFacets | undefined, pinned: string[], byCount: boolean, query: string): Item[] {
	const counts = new Map((facets?.address ?? []).map((f) => [f.value, f.count]));
	const q = query.trim().toLowerCase();
	const match = (s: string) => !q || s.toLowerCase().includes(q);
	const order = (a: { name: string; count: number }, b: { name: string; count: number }) =>
		byCount ? b.count - a.count || a.name.localeCompare(b.name) : a.name.localeCompare(b.name);
	const row = (address: string, indent: boolean): Item => ({
		key: `${indent ? "d" : "p"}:${address}`, chip: { kind: "address", value: address }, label: indent ? address.split("@")[0] : address,
		count: counts.get(address) ?? 0, indent,
	});
	const items: Item[] = [];
	const pins = pinned.filter((a) => addresses.includes(a) && match(a));
	if (pins.length) {
		items.push({ key: "h:pinned", chip: { kind: "address", value: "" }, label: "Pinned", heading: true });
		items.push(...pins.map((a) => row(a, false)));
	}
	const domains = [...new Set(addresses.map(domainOf))].map((domain) => {
		const members = addresses.filter((a) => domainOf(a) === domain);
		return { name: domain, members, count: members.reduce((n, a) => n + (counts.get(a) ?? 0), 0) };
	}).sort(order);
	for (const domain of domains) {
		const members = domain.members
			.map((a) => ({ name: a, count: counts.get(a) ?? 0 }))
			.sort(order)
			.filter((m) => match(m.name) || match(domain.name));
		if (!members.length) continue;
		// Typed text that names an address, not the domain: list the full addresses so Enter picks one.
		if (q && !match(domain.name)) {
			items.push(...members.map((m) => ({ ...row(m.name, false), key: `m:${m.name}` })));
			continue;
		}
		items.push({ key: `g:${domain.name}`, chip: { kind: "address", value: domain.name }, label: domain.name, count: domain.count });
		items.push(...members.map((m) => row(m.name, true)));
	}
	return items;
}

function fromItems(facets: MailFacets | undefined, byCount: boolean, query: string): Item[] {
	const q = query.trim().toLowerCase();
	const match = (s: string, name = "") => !q || s.includes(q) || name.toLowerCase().includes(q);
	const sort = <T extends { value: string; count: number }>(list: T[]) =>
		[...list].sort((a, b) => (byCount ? b.count - a.count || a.value.localeCompare(b.value) : a.value.localeCompare(b.value)));
	const items: Item[] = [];
	const domains = sort(facets?.from.domains ?? []).filter((d) => match(d.value));
	const addresses = sort(facets?.from.addresses ?? []).filter((a) => match(a.value, a.name));
	if (domains.length) {
		items.push({ key: "h:domains", chip: { kind: "from", value: "" }, label: "Domains", heading: true });
		items.push(...domains.map((d) => ({ key: `d:${d.value}`, chip: { kind: "from" as const, value: d.value }, label: d.value, count: d.count })));
	}
	if (addresses.length) {
		items.push({ key: "h:senders", chip: { kind: "from", value: "" }, label: "Senders", heading: true });
		items.push(...addresses.map((a) => ({
			key: `a:${a.value}`, chip: { kind: "from" as const, value: a.value }, label: a.name ? `${a.name} · ${a.value}` : a.value, count: a.count,
		})));
	}
	if (q && /^[^\s@]*@?[^\s@]+\.[^\s@]+$/.test(q) && !items.some((i) => i.chip.value === q.replace(/^@/, ""))) {
		items.unshift({ key: `use:${q}`, chip: { kind: "from", value: q.replace(/^@/, "") }, label: `Use “${q}”` });
	}
	return items;
}

function labelItems(labels: ReadonlyMap<string, Label>, facets: MailFacets | undefined, byCount: boolean, query: string): Item[] {
	const counts = new Map((facets?.label ?? []).map((f) => [f.value, f.count]));
	const q = query.trim().toLowerCase();
	return [...labels.values()]
		.filter((l) => !q || l.name.toLowerCase().includes(q))
		.map((l) => ({ key: l.id, chip: { kind: "label" as const, value: l.id }, label: l.name, count: counts.get(l.id) ?? 0, color: l.color }))
		.sort((a, b) => (byCount ? b.count - a.count : 0) || a.label.localeCompare(b.label));
}

function FilterPopover({
	kind, filter, addresses, labels, onChange, onClose,
}: {
	kind: PopoverKind;
	filter: MailFilter;
	addresses: string[];
	labels: ReadonlyMap<string, Label>;
	onChange: (filter: MailFilter, keepOpen: boolean) => void;
	onClose: () => void;
}) {
	const [query, setQuery] = useState("");
	const [byCount, setByCount] = useState(true);
	const { prefs } = useDirectoryPrefs();
	const { data: facets, isFetching } = useMailFacets(filter, true);
	const ref = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		inputRef.current?.focus();
		const onDown = (event: MouseEvent) => {
			if (!ref.current?.contains(event.target as Node) && !(event.target as Element).closest?.("[data-popover-anchor]")) onClose();
		};
		document.addEventListener("mousedown", onDown);
		return () => document.removeEventListener("mousedown", onDown);
	}, [onClose]);

	const items: Item[] = useMemo(() => {
		if (kind === "address") return addressItems(addresses, facets, prefs.pinned, byCount, query);
		if (kind === "from") return fromItems(facets, byCount, query);
		if (kind === "label") return labelItems(labels, facets, byCount, query);
		if (kind === "date") {
			return DATE_TOKENS.map((token) => ({ key: token, chip: { kind: "date" as const, value: token }, label: DATE_LABELS[token], count: facets?.date[token] }));
		}
		return STATUS_ITEMS.map((s) => ({ key: s.facet, chip: s.chip, label: s.label, count: facets?.status[s.facet] }))
			.filter((i) => !query || i.label.toLowerCase().includes(query.toLowerCase()));
	}, [kind, addresses, labels, facets, prefs.pinned, byCount, query]);

	// Address, From and Label take several values, so the popover stays open after a pick.
	const multi = kind === "address" || kind === "from" || kind === "label";
	const pick = (item: Item) => {
		const chips = hasChip(filter, item.chip) ? removeChip(filter.chips, item.chip) : addChip(filter.chips, item.chip);
		onChange({ ...filter, chips }, multi);
		if (!multi) onClose();
	};
	const first = items.find((i) => !i.heading);
	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Enter" && first) {
			event.preventDefault();
			// Enter only adds; it never removes a chip that is already on.
			if (!hasChip(filter, first.chip)) pick(first);
			setQuery("");
		}
		if (event.key === "Escape") {
			event.preventDefault();
			onClose();
		}
	};

	return (
		<div ref={ref} className="mail-popover" data-mail-popover role="dialog" aria-label={`${TITLES[kind]} filter`}>
			<div className="mail-popover-head">
				<span className="mail-caption">{TITLES[kind]}</span>
				{multi && (
					<button type="button" className="mail-link" onClick={() => setByCount(!byCount)}>
						{byCount ? "Most mail first" : "A to Z"}
					</button>
				)}
			</div>
			{kind !== "date" && (
				<label className="mail-popover-search">
					<MagnifyingGlassIcon size={14} aria-hidden />
					<input
						ref={inputRef}
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						onKeyDown={onKeyDown}
						placeholder={kind === "from" ? "Sender or domain" : kind === "label" ? "Label name" : `Filter ${TITLES[kind].toLowerCase()}`}
						aria-label={`Filter ${TITLES[kind].toLowerCase()}`}
					/>
				</label>
			)}
			<div className="mail-popover-list" role="listbox" aria-multiselectable={multi} aria-busy={isFetching}>
				{items.length === 0 && (
					<p className="mail-popover-empty">
						{kind === "label" && labels.size === 0 ? "No labels yet. Create them from the Label button or Settings." : facets ? "No match" : "Loading"}
					</p>
				)}
				{items.map((item) =>
					item.heading ? (
						<p key={item.key} className="mail-caption mail-popover-heading">{item.label}</p>
					) : (
						<button
							key={item.key}
							type="button"
							role="option"
							aria-selected={hasChip(filter, item.chip)}
							className={`mail-popover-item${item.indent ? " is-indented" : ""}${item.count === 0 ? " is-zero" : ""}`}
							onClick={() => pick(item)}
							onKeyDown={(e) => e.key === "Escape" && onClose()}
						>
							<span className="mail-check" aria-hidden>{hasChip(filter, item.chip) ? <CheckIcon size={12} weight="bold" /> : null}</span>
							{item.color && <LabelSwatch color={item.color} />}
							<span className="mail-popover-label">{item.label}</span>
							{item.count !== undefined && <b>{item.count.toLocaleString()}</b>}
						</button>
					),
				)}
			</div>
		</div>
	);
}

export default function ScopeBar({
	filter, addresses, labels, onChange, onFocusText, openPopover, setOpenPopover, children,
}: {
	filter: MailFilter;
	addresses: string[];
	labels: ReadonlyMap<string, Label>;
	onChange: (filter: MailFilter) => void;
	onFocusText: (text: string) => void;
	openPopover: PopoverKind | null;
	setOpenPopover: (kind: PopoverKind | null) => void;
	children?: ReactNode;
}) {
	const buttons: PopoverKind[] = ["address", "from", "label", "date", "status"];
	const names = new Map([...labels.values()].map((l) => [l.id, l.name]));
	return (
		<div className="mail-scope" role="toolbar" aria-label="Filters">
			{buttons.map((kind) => (
				<div key={kind} className="mail-scope-slot">
					<button
						type="button"
						className="mail-button"
						data-popover-anchor
						aria-expanded={openPopover === kind}
						onClick={() => setOpenPopover(openPopover === kind ? null : kind)}
					>
						{TITLES[kind]}
						<CaretDownIcon size={11} weight="bold" aria-hidden />
					</button>
					{openPopover === kind && (
						<FilterPopover
							kind={kind}
							filter={filter}
							addresses={addresses}
							labels={labels}
							onChange={(next) => onChange(next)}
							onClose={() => setOpenPopover(null)}
						/>
					)}
				</div>
			))}
			<span className="mail-scope-divider" aria-hidden />
			{filter.chips.map((chip) => {
				const popover = POPOVER_FOR[chip.kind];
				const text = chip.kind === "label" ? `Label ${chipLabel(chip, names)}` : chipLabel(chip);
				const color = chip.kind === "label" ? labels.get(chip.value)?.color : undefined;
				return (
					<span key={`${chip.kind}:${chip.value}`} className="mail-chip">
						<button
							type="button"
							data-popover-anchor
							onClick={() => (chip.kind === "q" ? onFocusText(chip.value) : popover && setOpenPopover(popover))}
						>
							{color && <LabelSwatch color={color} />}
							{text}
						</button>
						<button type="button" aria-label={`Remove ${text}`} onClick={() => onChange({ ...filter, chips: removeChip(filter.chips, chip) })}>
							<XIcon size={11} weight="bold" />
						</button>
					</span>
				);
			})}
			{filter.chips.length > 0 && (
				<button type="button" className="mail-link mail-clear" onClick={() => onChange({ ...filter, chips: [] })}>
					Clear all
				</button>
			)}
			{children}
		</div>
	);
}
