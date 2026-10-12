// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The ? dialog's map: a sketch of the mail view, its columns and buttons
 * drawn like the real ones, with each shortcut where it acts. Placement comes
 * from shared/shortcuts.ts (area, primary, cluster, header); ICONS below
 * gives a shortcut the icon of the button it presses. A shortcut without an
 * icon shows its short label, so a new one still lands in place.
 */

import {
	ArchiveIcon, ArrowBendDoubleUpLeftIcon, ArrowBendUpLeftIcon, ArrowBendUpRightIcon, ArrowCounterClockwiseIcon,
	CaretDoubleLeftIcon, CaretDoubleRightIcon, EnvelopeSimpleIcon, type Icon, MagnifyingGlassIcon, PaperPlaneTiltIcon,
	PencilSimpleLineIcon, SquareIcon, StarIcon, TagIcon, TrashIcon,
} from "@phosphor-icons/react";
import { Fragment } from "react";
import { keycaps, SHORTCUTS, type ShortcutArea, type ShortcutDef, type ShortcutId } from "shared/shortcuts";
import { AgentIcon } from "./AgentIcon";
import { AllAddressesIcon, DraftsIcon, InboxIcon, SentIcon, StarredIcon } from "./NavIcons";
import { useShortcuts } from "./shortcuts";

const ALL: readonly ShortcutDef[] = SHORTCUTS;

type AnyIcon = Icon | React.ComponentType<{ size?: number }>;

/** The icon of the button a shortcut presses, as the app draws it. */
const ICONS: Partial<Record<ShortcutId, AnyIcon>> = {
	goInbox: InboxIcon, goStarred: StarredIcon, goDrafts: DraftsIcon, goSent: SentIcon,
	reply: ArrowBendUpLeftIcon, replyAll: ArrowBendDoubleUpLeftIcon, forward: ArrowBendUpRightIcon,
	archive: ArchiveIcon, trash: TrashIcon, read: EnvelopeSimpleIcon, star: StarIcon, label: TagIcon,
	compose: PencilSimpleLineIcon, select: SquareIcon, send: PaperPlaneTiltIcon, undo: ArrowCounterClockwiseIcon,
};

/** Mail-view shortcuts in an area, plus any primary ones from the composer or search box. */
const inArea = (area: ShortcutArea) => ALL.filter((s) => s.area === area && (s.scope === "mail" || s.primary));
const name = (s: ShortcutDef) => s.short ?? s.label;

function Keys({ id, big }: { id: ShortcutId; big?: boolean }) {
	const { bindings, mac } = useShortcuts();
	const keys = bindings.get(id) ?? [];
	if (!keys.length) return <span className="pg-map-none">–</span>;
	return (
		<span className="pg-map-keys">
			{keys.map((k) => (
				<span key={k} className="pg-map-binding">
					{keycaps(k, mac).map((cap, j) => <kbd key={j} className="pg-map-cap" data-big={big || undefined}>{cap}</kbd>)}
				</span>
			))}
		</span>
	);
}

function Glyph({ def, size = 15 }: { def: ShortcutDef; size?: number }) {
	const I = ICONS[def.id as ShortcutId];
	return I ? <I size={size} /> : <span className="pg-map-word">{name(def)}</span>;
}

/** A column's header bar, like the real one, with its collapse key where the collapse button is. */
function Head({ area, title, icon, side }: { area: ShortcutArea; title: string; icon: React.ReactNode; side: "left" | "right" }) {
	const toggles = ALL.filter((s) => s.area === area && s.header);
	const caret = side === "left" ? <CaretDoubleLeftIcon size={12} weight="bold" /> : <CaretDoubleRightIcon size={12} weight="bold" />;
	return (
		<div className="pg-map-head">
			{side === "right" && caret}
			{side === "left" && icon}
			<span className="pg-flex">{title}</span>
			{toggles.map((s) => <span key={s.id} title={s.label}><Keys id={s.id as ShortcutId} /></span>)}
			{side === "left" ? caret : icon}
		</div>
	);
}

function Sidebar() {
	const items = inArea("go").filter((s) => !s.header);
	return (
		<section className="pg-map-col" data-area="go" aria-label="Sidebar">
			<Head area="go" title="All addresses" icon={<AllAddressesIcon size={13} />} side="left" />
			<div className="pg-map-body">
				{items.map((s) => (
					<div key={s.id} className="pg-map-nav" title={s.label}>
						{ICONS[s.id as ShortcutId] && <Glyph def={s} />}
						<span className="pg-flex">{ICONS[s.id as ShortcutId] ? name(s) : s.label}</span>
						<Keys id={s.id as ShortcutId} />
					</div>
				))}
			</div>
		</section>
	);
}

function List() {
	const items = inArea("list");
	const byId = new Map(items.map((s) => [s.id, s]));
	const prev = byId.get("prev");
	const next = byId.get("next");
	const select = byId.get("select");
	const compose = byId.get("compose");
	const rest = items.filter((s) => !["prev", "next", "select", "compose"].includes(s.id));
	return (
		<section className="pg-map-col" data-area="list" aria-label="List">
			<div className="pg-map-head">
				<InboxIcon size={13} />
				<span className="pg-flex">Inbox</span>
				{compose && (
					<span className="pg-map-btn" title={compose.label}><Glyph def={compose} size={13} /><Keys id="compose" /></span>
				)}
			</div>
			<div className="pg-map-body pg-map-rows">
				{prev && <div className="pg-map-step" title={prev.label}><Keys id="prev" big /></div>}
				<div className="pg-map-mail" aria-hidden="true"><i /><i /></div>
				<div className="pg-map-mail" data-current>
					{select && <span className="pg-map-check" title={select.label}><Keys id="select" /></span>}
					<span className="pg-map-lines" aria-hidden="true"><i /><i /></span>
				</div>
				<div className="pg-map-mail" aria-hidden="true"><i /><i /></div>
				{next && <div className="pg-map-step" title={next.label}><Keys id="next" big /></div>}
				{rest.map((s) => <div key={s.id} className="pg-map-nav" title={s.label}><Glyph def={s} /><span className="pg-flex" /><Keys id={s.id as ShortcutId} /></div>)}
			</div>
		</section>
	);
}

function Reader() {
	const tools = inArea("toolbar");
	const clusters = [...new Set(tools.map((t) => t.cluster ?? 0))].sort((a, b) => a - b).map((c) => tools.filter((t) => (t.cluster ?? 0) === c));
	return (
		<section className="pg-map-col" data-area="reader" aria-label="Message">
			<div className="pg-map-toolbar" role="list">
				{clusters.map((group, i) => (
					<Fragment key={i}>
						{i > 0 && <i className="pg-map-sep" aria-hidden="true" />}
						{group.map((t) => (
							<div key={t.id} className="pg-map-tool" role="listitem" title={t.label} data-primary={t.primary || undefined}>
								<Glyph def={t} size={16} />
								<Keys id={t.id as ShortcutId} big={t.primary} />
							</div>
						))}
					</Fragment>
				))}
			</div>
			<div className="pg-map-body pg-map-page" aria-hidden="true"><i /><i /><i /><i /></div>
			{inArea("composer").map((s) => (
				<div key={s.id} className="pg-map-composer" title={s.label}>
					<PencilSimpleLineIcon size={13} />
					<span className="pg-flex" />
					<Keys id={s.id as ShortcutId} />
					<Glyph def={s} size={14} />
				</div>
			))}
		</section>
	);
}

function Agent() {
	const items = inArea("agent").filter((s) => !s.header);
	return (
		<section className="pg-map-col" data-area="agent" aria-label="Agent">
			<Head area="agent" title="Agent" icon={<AgentIcon size={13} weight="fill" color="var(--pg-green)" />} side="right" />
			<div className="pg-map-body">
				{items.map((s) => <div key={s.id} className="pg-map-nav" title={s.label}><Glyph def={s} /><span className="pg-flex" /><Keys id={s.id as ShortcutId} /></div>)}
			</div>
		</section>
	);
}

export function ShortcutMap({ onAll }: { onAll: () => void }) {
	return (
		<div className="pg-map">
			<div className="pg-map-search" title="Search">
				<MagnifyingGlassIcon size={14} aria-hidden="true" />
				<span className="pg-flex" />
				{inArea("search").map((s) => <Keys key={s.id} id={s.id as ShortcutId} big={s.primary} />)}
			</div>
			<div className="pg-map-cols">
				<Sidebar />
				<List />
				<Reader />
				<Agent />
			</div>
			<div className="pg-map-more">
				{inArea("more").map((s) => (
					<div key={s.id} className="pg-map-nav" title={s.label}>
						<Keys id={s.id as ShortcutId} />
						{ICONS[s.id as ShortcutId] ? <Glyph def={s} /> : <span>{name(s)}</span>}
					</div>
				))}
				<span className="pg-flex" />
				<button type="button" className="pg-map-all" onClick={onAll}>All keys</button>
			</div>
		</div>
	);
}
