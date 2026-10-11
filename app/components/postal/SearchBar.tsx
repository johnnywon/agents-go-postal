// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { EnvelopeSimpleIcon, ListIcon, MagnifyingGlassIcon, PaperclipIcon, SparkleIcon, StarIcon, TagIcon, UserIcon, XIcon } from "@phosphor-icons/react";
import { forwardRef, useState } from "react";
import { AddressText, type Identities, Swatch } from "./identity";

export interface FilterSuggestion {
	token: string;
	desc: string;
	icon: "unread" | "starred" | "attachment" | "label" | "from";
	count?: number;
}

const ICONS = { unread: EnvelopeSimpleIcon, starred: StarIcon, attachment: PaperclipIcon, label: TagIcon, from: UserIcon };

export interface SearchBarProps {
	value: string;
	onChange: (value: string) => void;
	/** Enter while typing: open the first result. */
	onOpenFirst: () => void;
	/** ↑↓ while typing move through the list. */
	onMove: (delta: number) => void;
	resultCount: number | null;
	filters: FilterSuggestion[];
	addresses: { address: string; count?: number }[];
	identities: Identities;
	onMenu: () => void;
	onAgent: () => void;
	onFocusChange?: (focused: boolean) => void;
}

export const SearchBar = forwardRef<HTMLInputElement, SearchBarProps>(function SearchBar(props, ref) {
	const [focused, setFocused] = useState(false);
	const [active, setActive] = useState(-1);
	const hasQ = props.value.trim().length > 0;
	const suggest = focused && !hasQ;
	const items = [...props.filters.map((f) => f.token), ...props.addresses.map((a) => `to:${a.address}`)];

	const add = (token: string) => {
		props.onChange(`${`${props.value.trim()} ${token}`.trim()} `);
		setActive(-1);
	};

	const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Escape") {
			e.preventDefault();
			if (props.value) props.onChange("");
			else e.currentTarget.blur();
			return;
		}
		if (suggest) {
			if (e.key === "ArrowDown" || e.key === "ArrowUp") {
				e.preventDefault();
				const d = e.key === "ArrowDown" ? 1 : -1;
				setActive((i) => (items.length ? (i + d + items.length) % items.length : -1));
			} else if (e.key === "Enter" && active >= 0 && items[active]) {
				e.preventDefault();
				add(items[active]);
			}
			return;
		}
		if (e.key === "Enter") {
			e.preventDefault();
			props.onOpenFirst();
			e.currentTarget.blur();
		} else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			props.onMove(e.key === "ArrowDown" ? 1 : -1);
		}
	};

	return (
		<div className="pg-search-wrap">
			<div className="pg-search" data-suggest={suggest} data-active={hasQ || focused} role="search">
				<button type="button" className="pg-icon-btn pg-mobile-only" onClick={props.onMenu} aria-label="Open menu">
					<ListIcon size={16} />
				</button>
				<MagnifyingGlassIcon size={14} className="pg-search-icon" aria-hidden />
				<input
					ref={ref}
					value={props.value}
					onChange={(e) => {
						props.onChange(e.target.value);
						setActive(-1);
					}}
					onFocus={() => {
						setFocused(true);
						props.onFocusChange?.(true);
					}}
					onBlur={() => {
						setFocused(false);
						props.onFocusChange?.(false);
					}}
					onKeyDown={onKeyDown}
					placeholder="Search mail — try  from:stripe  is:unread  has:attachment"
					spellCheck={false}
					autoComplete="off"
					aria-label="Search mail"
					aria-expanded={suggest}
					aria-controls="pg-suggest"
					aria-activedescendant={suggest && active >= 0 ? `pg-sg-${active}` : undefined}
					role="combobox"
				/>
				{hasQ && (
					<>
						{props.resultCount !== null && (
							<span className="pg-result-count">{props.resultCount.toLocaleString()} result{props.resultCount === 1 ? "" : "s"}</span>
						)}
						<button type="button" className="pg-clear" title="Clear search (Esc)" aria-label="Clear search" onMouseDown={(e) => { e.preventDefault(); props.onChange(""); }}>
							<XIcon size={14} />
						</button>
					</>
				)}
				<img className="deck-brand-logo pg-watermark" src="/brand/logo.svg" alt="" aria-hidden="true" />
				<span className="pg-kbd pg-desktop-only">/</span>
				<button type="button" className="pg-icon-btn pg-mobile-only" onClick={props.onAgent} aria-label="Ask agent">
					<SparkleIcon size={16} weight="fill" />
				</button>
			</div>
			{suggest && (
				<div className="pg-popover pg-suggest" id="pg-suggest" role="listbox" aria-label="Search suggestions">
					<div className="pg-suggest-grid">
						<div className="pg-suggest-col">
							<span className="pg-caption">FILTERS</span>
							{props.filters.map((f, i) => {
								const Icon = ICONS[f.icon];
								return (
									<button
										key={f.token}
										id={`pg-sg-${i}`}
										type="button"
										role="option"
										aria-selected={active === i}
										data-active={active === i}
										className="pg-menu-item pg-suggest-item"
										onMouseDown={(e) => { e.preventDefault(); add(f.token); }}
									>
										<Icon size={14} color="var(--pg-text-6)" style={{ flex: "none" }} />
										<span className="pg-flex pg-ellipsis">{f.desc}</span>
										<span className="pg-token">{f.token}</span>
										<span className="pg-count">{f.count === undefined ? "" : f.count.toLocaleString()}</span>
									</button>
								);
							})}
						</div>
						<div className="pg-suggest-col">
							<span className="pg-caption">ADDRESSES</span>
							{props.addresses.map((a, j) => {
								const i = props.filters.length + j;
								const identity = props.identities.of(a.address);
								return (
									<button
										key={a.address}
										id={`pg-sg-${i}`}
										type="button"
										role="option"
										aria-selected={active === i}
										data-active={active === i}
										className="pg-menu-item pg-suggest-item pg-suggest-addr"
										onMouseDown={(e) => { e.preventDefault(); add(`to:${a.address}`); }}
									>
										<Swatch identity={identity} />
										<span className="pg-flex pg-ellipsis"><AddressText address={a.address} identity={identity} bold={false} /></span>
										<span className="pg-count">{a.count ? a.count.toLocaleString() : ""}</span>
									</button>
								);
							})}
						</div>
					</div>
					<div className="pg-suggest-foot">
						<span>Combine filters with words: <b>from:stripe is:unread</b></span>
						<span className="pg-flex" />
						<span className="pg-keyhint">↵ open · ↑↓ move · esc close</span>
					</div>
				</div>
			)}
		</div>
	);
});
