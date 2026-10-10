// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { CheckIcon, MagnifyingGlassIcon, PlusIcon } from "@phosphor-icons/react";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import type { Label } from "~/services/api";
import { LabelSwatch } from "./LabelChip";

export interface PickerLabel extends Label {
	/** Conversations in the current view that carry the label. */
	inView?: number;
	/** Every target already has the label. */
	checked: boolean;
}

/**
 * Label picker. Clicking toggles a label on every target and the picker stays
 * open; Enter adds the first match and never removes; a new name offers to
 * create the label.
 */
export default function LabelPicker({
	labels, targetCount, onToggle, onCreate, onArchive, onClose, busy,
}: {
	labels: PickerLabel[];
	targetCount: number;
	onToggle: (label: PickerLabel) => void;
	onCreate: (name: string) => void;
	onArchive: () => void;
	onClose: () => void;
	busy: boolean;
}) {
	const [query, setQuery] = useState("");
	const ref = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		inputRef.current?.focus();
		const onDown = (event: MouseEvent) => {
			const target = event.target as Element;
			if (!ref.current?.contains(target) && !target.closest?.("[data-label-anchor]")) onClose();
		};
		document.addEventListener("mousedown", onDown);
		return () => document.removeEventListener("mousedown", onDown);
	}, [onClose]);

	const q = query.trim().toLowerCase();
	const matches = useMemo(() => labels.filter((l) => !q || l.name.toLowerCase().includes(q)), [labels, q]);
	const exact = labels.some((l) => l.name.toLowerCase() === q);

	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Escape") {
			event.preventDefault();
			onClose();
		}
		if (event.key !== "Enter") return;
		event.preventDefault();
		const first = matches[0];
		if (first) {
			if (!first.checked) onToggle(first);
		} else if (q) onCreate(query.trim());
		setQuery("");
	};

	const title = targetCount === 1 ? "Label conversation" : `Label ${targetCount.toLocaleString()} conversations`;
	return (
		<div ref={ref} className="mail-popover mail-label-picker" data-mail-popover role="dialog" aria-label={title}>
			<div className="mail-popover-head">
				<span className="mail-caption">{title}</span>
			</div>
			<label className="mail-popover-search">
				<MagnifyingGlassIcon size={14} aria-hidden />
				<input
					ref={inputRef}
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					onKeyDown={onKeyDown}
					placeholder="Label name"
					aria-label="Find or create a label"
				/>
			</label>
			<div className="mail-popover-list" role="listbox" aria-multiselectable aria-busy={busy}>
				{matches.length === 0 && !q && <p className="mail-popover-empty">No labels yet. Type a name.</p>}
				{matches.map((label) => (
					<button
						key={label.id}
						type="button"
						role="option"
						aria-selected={label.checked}
						className={`mail-popover-item${label.inView === 0 ? " is-zero" : ""}`}
						onClick={() => onToggle(label)}
					>
						<span className="mail-check" aria-hidden>{label.checked ? <CheckIcon size={12} weight="bold" /> : null}</span>
						<LabelSwatch color={label.color} />
						<span className="mail-popover-label">{label.name}</span>
						{label.inView !== undefined && <b>{label.inView.toLocaleString()}</b>}
					</button>
				))}
				{q && !exact && (
					<button type="button" className="mail-popover-item" onClick={() => { onCreate(query.trim()); setQuery(""); }}>
						<span className="mail-check" aria-hidden><PlusIcon size={12} weight="bold" /></span>
						<span className="mail-popover-label">New label “{query.trim()}”</span>
					</button>
				)}
			</div>
			<div className="mail-popover-foot">
				<button type="button" className="mail-button" onClick={onArchive}>Label and archive</button>
			</div>
		</div>
	);
}
