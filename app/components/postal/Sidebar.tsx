// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	BookmarkSimpleIcon, CaretDoubleLeftIcon, KeyboardIcon, CaretDoubleRightIcon, CaretDownIcon, CaretRightIcon, GearSixIcon,
	PencilSimpleIcon, PlugsConnectedIcon, PlusIcon, SignOutIcon,
} from "@phosphor-icons/react";
import { AgentIcon } from "./AgentIcon";
import {
	AllAddressesIcon, ArchiveIcon, ByAddressIcon, DraftsIcon, InboxIcon, LabelsIcon, SentIcon, SpamIcon, StarredIcon, TrashIcon, UnreadIcon,
} from "./NavIcons";
import { useShortcuts } from "./shortcuts";
import { type FormEvent, useState } from "react";
import type { MailFilter } from "~/lib/mail-filter";
import type { Label, SavedSearch } from "~/services/api";
import { AddressText, type Identities, LabelTag, Swatch } from "./identity";
import { HOME, labelOf, scopeOf, scoped } from "./model";

export const SECONDARY_VIEWS = [
	{ view: "starred", label: "Starred", Icon: StarredIcon },
	{ view: "drafts", label: "Drafts", Icon: DraftsIcon },
	{ view: "sent", label: "Sent", Icon: SentIcon },
	{ view: "archive", label: "Archive", Icon: ArchiveIcon },
	{ view: "spam", label: "Spam", Icon: SpamIcon },
	{ view: "trash", label: "Trash", Icon: TrashIcon },
] as const;

const ADDRESS_FOLDERS = [{ view: "inbox", label: "Inbox", Icon: InboxIcon }, ...SECONDARY_VIEWS] as const;

export interface SidebarProps {
	identities: Identities;
	filter: MailFilter;
	go: (filter: MailFilter) => void;
	allUnread?: number;
	unreadByAddress: ReadonlyMap<string, number>;
	labels: Label[];
	onCreateLabel: (name: string) => void;
	onAskLabel: (label: Label) => void;
	saved: SavedSearch[];
	/** The search in the box, to mark the saved search it matches. */
	search: string;
	onSavedSearch: (saved: SavedSearch) => void;
	mailboxesOpen: boolean;
	labelsOpen: boolean;
	setLayout: (patch: { mailboxesOpen?: boolean; labelsOpen?: boolean }) => void;
	onCollapse: () => void;
	onMcp: () => void;
	onSettings: () => void;
	/** Opens Settings on its Labels tab. */
	onManageLabels: () => void;
	onLogout: () => void;
	onShortcuts: () => void;
	overlay?: boolean;
	drawer?: "open" | "closed";
}

function count(n: number | undefined) {
	return n ? n.toLocaleString() : "";
}

export function Sidebar(props: SidebarProps) {
	const { identities, filter, go, unreadByAddress, labels } = props;
	const scope = scopeOf(filter);
	const labelView = labelOf(filter);
	const globalView = !scope && !labelView ? filter.view : null;
	const [newLabel, setNewLabel] = useState<string | null>(null);

	const domainUnread = (domain: string) =>
		[...unreadByAddress.entries()].reduce((sum, [address, n]) => (address.endsWith(`@${domain}`) ? sum + n : sum), 0);

	const submitLabel = (event: FormEvent) => {
		event.preventDefault();
		const name = newLabel?.trim();
		if (name) props.onCreateLabel(name);
		setNewLabel(null);
	};

	const { tip } = useShortcuts();
	return (
		<nav className="pg-nav" aria-label="Mail" data-overlay={props.overlay || undefined} data-drawer={props.drawer}>
			<button type="button" className="pg-rail-head" onClick={props.onCollapse} title={tip("sidebar", "Collapse sidebar")}>
				<AllAddressesIcon size={14} />
				<span className="pg-flex" style={{ lineHeight: 1, textAlign: "left" }}>ALL ADDRESSES</span>
				<CaretDoubleLeftIcon size={14} weight="bold" />
			</button>
			<div className="pg-nav-scroll">
				<button type="button" className="pg-nav-item" aria-current={globalView === "inbox" || undefined} onClick={() => go({ ...HOME, chips: [] })}>
					<InboxIcon size={16} />
					<span className="pg-flex">Inbox</span>
				</button>
				<button type="button" className="pg-nav-item" aria-current={globalView === "unread" || undefined} onClick={() => go({ ...HOME, view: "unread", chips: [] })}>
					<UnreadIcon size={16} />
					<span className="pg-flex">Unread</span>
					<span className="pg-count" style={{ color: "var(--pg-text-6)" }}>{count(props.allUnread)}</span>
				</button>
				{/* TODO(roadmap): "Needs you" and "Agent handled" views, with their counts, return when the agent can hand work back. */}
				<div className="pg-nav-secondary">
					{SECONDARY_VIEWS.map(({ view, label, Icon }) => (
						<button key={view} type="button" className="pg-nav-small" aria-current={globalView === view || undefined} onClick={() => go(scoped(view, null, filter))}>
							<Icon size={14} />
							<span className="pg-ellipsis pg-flex">{label}</span>
						</button>
					))}
				</div>

				<div className="pg-nav-divider" />
				<button type="button" className="pg-nav-item" aria-expanded={props.mailboxesOpen} onClick={() => props.setLayout({ mailboxesOpen: !props.mailboxesOpen })}>
					<ByAddressIcon size={16} />
					<span className="pg-flex">By address</span>
					<span style={{ display: "flex", gap: 3 }}>
						{identities.groups.map((g) => <Swatch key={g.identity.domain} identity={g.identity} />)}
					</span>
					{props.mailboxesOpen ? <CaretDownIcon size={10} weight="bold" color="var(--pg-text-8)" /> : <CaretRightIcon size={10} weight="bold" color="var(--pg-text-8)" />}
				</button>
				{props.mailboxesOpen && identities.groups.map(({ identity, addresses }) => (
					<div key={identity.domain} style={{ display: "flex", flexDirection: "column", gap: 1 }}>
						<button
							type="button"
							className="pg-nav-domain"
							aria-current={scope === identity.domain || undefined}
							onClick={() => go(scoped("inbox", scope === identity.domain ? null : identity.domain, filter))}
						>
							<Swatch identity={identity} size={10} />
							<span className="pg-name">{identity.domain}</span>
							<span className="pg-count">{count(domainUnread(identity.domain))}</span>
						</button>
						{addresses.map((address) => {
							const open = scope === address;
							return (
								<div key={address} style={{ display: "contents" }}>
									<button
										type="button"
										className="pg-nav-address"
										data-open={open}
										aria-expanded={open}
										onClick={() => go(scoped("inbox", open ? null : address, filter))}
									>
										<span className="pg-flex pg-ellipsis">
											<AddressText address={address} identity={identity} short bold={false} />
										</span>
										{/* TODO(roadmap): per-address agent autonomy pill (off / draft / rules / auto) returns with rules. */}
										<span className="pg-n">{count(unreadByAddress.get(address))}</span>
									</button>
									{open && (
										<div className="pg-nav-folders">
											{ADDRESS_FOLDERS.map(({ view, label, Icon }) => (
												<button
													key={view}
													type="button"
													className="pg-nav-folder"
													aria-current={filter.view === view || undefined}
													onClick={() => go(scoped(view, address, filter))}
												>
													<Icon size={14} />
													<span className="pg-flex">{label}</span>
												</button>
											))}
										</div>
									)}
								</div>
							);
						})}
					</div>
				))}

				<div className="pg-nav-divider" />
				<button type="button" className="pg-nav-item" aria-expanded={props.labelsOpen} onClick={() => props.setLayout({ labelsOpen: !props.labelsOpen })}>
					<LabelsIcon size={16} />
					<span className="pg-flex">Labels</span>
					{props.labelsOpen ? <CaretDownIcon size={10} weight="bold" color="var(--pg-text-8)" /> : <CaretRightIcon size={10} weight="bold" color="var(--pg-text-8)" />}
				</button>
				{props.labelsOpen && (
					<>
						{labels.map((label) => {
							const on = labelView === label.id;
							return (
								<div
									key={label.id}
									role="button"
									tabIndex={0}
									className="pg-nav-label"
									aria-current={on || undefined}
									title={label.auto ? `${label.name} · applied by the agent` : label.name}
									onClick={() => go(on ? { ...HOME, chips: [] } : { view: "all", chips: [{ kind: "label", value: label.id }], sort: filter.sort, dir: filter.dir })}
									onKeyDown={(e) => {
										if (e.key === "Enter" || e.key === " ") {
											e.preventDefault();
											(e.currentTarget as HTMLElement).click();
										}
									}}
								>
									<LabelTag id={label.id} size={13} />
									<span className="pg-flex pg-ellipsis">{label.name}</span>
									{label.auto && (
										<button
											type="button"
											className="pg-sparkle"
											title={`Ask the agent about ${label.name}`}
											aria-label={`Ask the agent about ${label.name}`}
											onClick={(e) => {
												e.stopPropagation();
												props.onAskLabel(label);
											}}
										>
											<AgentIcon size={14} weight="fill" />
										</button>
									)}
									<span className="pg-count" style={{ fontWeight: 400, minWidth: 16, textAlign: "right" }}>{count(label.count)}</span>
								</div>
							);
						})}
						{newLabel === null ? (
							<>
								<button type="button" className="pg-nav-new" onClick={() => setNewLabel("")}>
									<PlusIcon size={12} />
									<span>New label</span>
								</button>
								<button type="button" className="pg-nav-new" onClick={props.onManageLabels} title="Rename, recolour or delete labels">
									<PencilSimpleIcon size={12} />
									<span>Manage labels</span>
								</button>
							</>
						) : (
							<form onSubmit={submitLabel}>
								<input
									className="pg-nav-new-input"
									autoFocus
									value={newLabel}
									placeholder="Label name"
									aria-label="New label name"
									maxLength={60}
									onChange={(e) => setNewLabel(e.target.value)}
									onBlur={() => setNewLabel(null)}
									onKeyDown={(e) => e.key === "Escape" && setNewLabel(null)}
								/>
							</form>
						)}
					</>
				)}
				{props.saved.length > 0 && (
					<>
						<div className="pg-nav-divider" />
						<span className="pg-caption pg-nav-caption">Saved searches</span>
						{props.saved.map((s) => {
							const on = props.search.replace(/\s+/g, " ").trim() === s.query;
							return (
								<button
									key={s.id}
									type="button"
									className="pg-nav-label"
									aria-current={on || undefined}
									title={s.name === s.query ? s.query : `${s.name} · ${s.query}`}
									onClick={() => props.onSavedSearch(s)}
								>
									<BookmarkSimpleIcon size={13} color="var(--pg-text-6)" style={{ flex: "none" }} />
									<span className="pg-flex pg-ellipsis">{s.name}</span>
									<span className="pg-count" style={{ fontWeight: 400, minWidth: 16, textAlign: "right" }}>{count(s.count ?? undefined)}</span>
								</button>
							);
						})}
					</>
				)}
				<div style={{ flex: 1, minHeight: 12 }} />
			</div>
			<div className="pg-nav-foot">
				<button type="button" className="pg-foot-btn" onClick={props.onMcp} title="MCP server · connect outside agents">
					<PlugsConnectedIcon size={14} />
					<span>MCP</span>
				</button>
				<button type="button" className="pg-foot-btn" onClick={props.onSettings} title="Settings">
					<GearSixIcon size={14} />
					<span>Settings</span>
				</button>
				<div className="pg-flex" />
				<button type="button" className="pg-foot-btn is-square" onClick={props.onShortcuts} title={tip("help", "Keyboard shortcuts")} aria-label="Keyboard shortcuts">
					<KeyboardIcon size={14} />
				</button>
				<button type="button" className="pg-foot-btn is-square" onClick={props.onLogout} title="Log out" aria-label="Log out">
					<SignOutIcon size={14} />
				</button>
			</div>
		</nav>
	);
}

export function NavRail({
	identities, filter, go, allUnread, unreadByAddress, onExpand, onLabels, onMcp, onSettings, onLogout, onShortcuts,
}: Pick<SidebarProps, "identities" | "filter" | "go" | "allUnread" | "unreadByAddress" | "onMcp" | "onSettings" | "onLogout" | "onShortcuts"> & {
	onExpand: () => void;
	onLabels: () => void;
}) {
	const scope = scopeOf(filter);
	const globalView = !scope && !labelOf(filter) ? filter.view : null;
	const domainUnread = (domain: string) =>
		[...unreadByAddress.entries()].reduce((sum, [address, n]) => (address.endsWith(`@${domain}`) ? sum + n : sum), 0);
	const { tip } = useShortcuts();
	return (
		<nav className="pg-navrail" aria-label="Mail">
			<button type="button" className="pg-rail-head" onClick={onExpand} title={tip("sidebar", "Expand sidebar")} aria-label="Expand sidebar">
				<AllAddressesIcon size={14} />
				<CaretDoubleRightIcon size={10} weight="bold" />
			</button>
			<div className="pg-navrail-scroll">
				<button
					type="button"
					className="pg-rail-tile"
					aria-current={globalView === "inbox" || undefined}
					title={`Inbox, all addresses · ${allUnread ?? 0} unread`}
					aria-label={`Inbox, all addresses, ${allUnread ?? 0} unread`}
					onClick={() => go({ ...HOME, chips: [] })}
				>
					<InboxIcon size={16} />
					<span className="pg-n">{allUnread ?? ""}</span>
				</button>
				{/* TODO(roadmap): "Needs you" and "Agent handled" rail tiles. */}
				{SECONDARY_VIEWS.slice(0, 4).map(({ view, label, Icon }) => (
					<button key={view} type="button" className="pg-rail-icon" title={label} aria-label={label} aria-current={globalView === view || undefined} onClick={() => go(scoped(view, null, filter))}>
						<Icon size={16} />
					</button>
				))}
				<div className="pg-rail-sep" />
				{identities.groups.map(({ identity }) => {
					const n = domainUnread(identity.domain);
					return (
						<button
							key={identity.domain}
							type="button"
							className="pg-rail-tile pg-rail-domain"
							aria-current={scope === identity.domain || undefined}
							title={`${identity.domain} · ${n} unread`}
							aria-label={`${identity.domain}, ${n} unread`}
							onClick={() => go(scoped("inbox", identity.domain, filter))}
						>
							<Swatch identity={identity} size={13} />
							<span className="pg-n">{n || ""}</span>
						</button>
					);
				})}
				<div className="pg-rail-sep" />
				<button type="button" className="pg-rail-tile" style={{ height: 40 }} title="Labels" aria-label="Labels" onClick={onLabels}>
					<LabelsIcon size={16} />
				</button>
				<div style={{ flex: 1 }} />
			</div>
			<div className="pg-rail-foot">
				<button type="button" onClick={onMcp} title="MCP" aria-label="MCP"><PlugsConnectedIcon size={16} /></button>
				<button type="button" onClick={onSettings} title="Settings" aria-label="Settings"><GearSixIcon size={16} /></button>
				<button type="button" onClick={onShortcuts} title={tip("help", "Keyboard shortcuts")} aria-label="Keyboard shortcuts"><KeyboardIcon size={16} /></button>
				<button type="button" onClick={onLogout} title="Log out" aria-label="Log out"><SignOutIcon size={16} /></button>
			</div>
		</nav>
	);
}
