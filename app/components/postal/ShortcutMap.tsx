// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The ? dialog's map: a sketch of the mail view with each shortcut drawn
 * where it acts. Everything comes from shared/shortcuts.ts (area, primary,
 * cluster, short), so a new shortcut places itself.
 */

import { MagnifyingGlassIcon, PencilSimpleLineIcon } from "@phosphor-icons/react";
import { Fragment } from "react";
import { keycaps, SHORTCUTS, type ShortcutArea, type ShortcutDef, type ShortcutId } from "shared/shortcuts";
import { useShortcuts } from "./shortcuts";

const ALL: readonly ShortcutDef[] = SHORTCUTS;

/** Mail-view shortcuts in an area, plus any primary ones from the composer or search box. */
const inArea = (area: ShortcutArea) => ALL.filter((s) => s.area === area && (s.scope === "mail" || s.primary));

function Keys({ id, big }: { id: ShortcutId; big?: boolean }) {
	const { bindings, mac } = useShortcuts();
	const keys = bindings.get(id) ?? [];
	if (!keys.length) return <span className="pg-map-none">None</span>;
	return (
		<span className="pg-map-keys">
			{keys.map((k, i) => (
				<Fragment key={k}>
					{i > 0 && <span className="pg-map-or">or</span>}
					{keycaps(k, mac).map((cap, j) => <kbd key={j} className="pg-map-cap" data-big={big || undefined}>{cap}</kbd>)}
				</Fragment>
			))}
		</span>
	);
}

function Row({ def }: { def: ShortcutDef }) {
	return (
		<div className="pg-map-row" data-primary={def.primary || undefined}>
			<Keys id={def.id as ShortcutId} big={def.primary} />
			<span>{def.short ?? def.label}</span>
		</div>
	);
}

function Column({ area, title, children }: { area: string; title: string; children?: React.ReactNode }) {
	return (
		<section className="pg-map-col" data-area={area} aria-label={title}>
			<h3>{title}</h3>
			{children}
		</section>
	);
}

/** The reader's toolbar: its button groups in order, each key in place. */
function Toolbar() {
	const tools = inArea("toolbar");
	const clusters = [...new Set(tools.map((t) => t.cluster ?? 0))].sort((a, b) => a - b).map((c) => tools.filter((t) => (t.cluster ?? 0) === c));
	return (
		<>
			<div className="pg-map-toolbar" role="list">
				{clusters.map((group, i) => (
					<Fragment key={i}>
						{i > 0 && <i className="pg-map-sep" aria-hidden="true" />}
						<div className="pg-map-group" role="listitem">
							{group.map((t) => <span key={t.id} title={t.label}><Keys id={t.id as ShortcutId} big={t.primary} /></span>)}
						</div>
					</Fragment>
				))}
			</div>
			<div className="pg-map-legend">
				{clusters.map((group, i) => <span key={i}>{group.map((t) => t.short ?? t.label).join(", ")}</span>)}
			</div>
		</>
	);
}

export function ShortcutMap({ onAll }: { onAll: () => void }) {
	const search = inArea("search");
	return (
		<div className="pg-map">
			<div className="pg-map-search">
				<MagnifyingGlassIcon size={14} aria-hidden="true" />
				<span className="pg-flex">Search mail</span>
				{search.map((s) => <Keys key={s.id} id={s.id as ShortcutId} big={s.primary} />)}
			</div>
			<div className="pg-map-cols">
				<Column area="go" title="Go to">{inArea("go").map((s) => <Row key={s.id} def={s} />)}</Column>
				<Column area="list" title="List">
					{inArea("list").map((s) => <Row key={s.id} def={s} />)}
					<div className="pg-map-lines" aria-hidden="true"><i /><i /><i /></div>
				</Column>
				<Column area="reader" title="Message">
					<Toolbar />
					{inArea("composer").map((s) => (
						<div key={s.id} className="pg-map-composer">
							<PencilSimpleLineIcon size={13} aria-hidden="true" />
							<span>Composer</span>
							<Keys id={s.id as ShortcutId} />
							<span>{s.short ?? s.label}</span>
						</div>
					))}
				</Column>
				<Column area="agent" title="Agent">{inArea("agent").map((s) => <Row key={s.id} def={s} />)}</Column>
			</div>
			<div className="pg-map-more">
				{inArea("more").map((s) => <Row key={s.id} def={s} />)}
				<button type="button" className="pg-map-all" onClick={onAll}>Editor and search box keys</button>
			</div>
		</div>
	);
}
