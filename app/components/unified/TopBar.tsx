// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { ArrowsClockwiseIcon, GearSixIcon, ListIcon, RobotIcon } from "@phosphor-icons/react";
import { Link } from "react-router";
import DeckBrand from "~/components/DeckBrand";
import { drillPath, type LabelNames, type MailFilter, viewLabel } from "~/lib/mail-filter";

export default function TopBar({
	filter, labelNames, addressCount, total, unread, indexing, refreshing, agentOpen, onRefresh, onToggleAgent, onToggleSources,
}: {
	filter: MailFilter;
	labelNames: LabelNames;
	addressCount: number;
	total?: number;
	unread?: number;
	indexing: { done: number; total: number } | null;
	refreshing: boolean;
	agentOpen: boolean;
	onRefresh: () => void;
	onToggleAgent: () => void;
	onToggleSources: () => void;
}) {
	const path = drillPath(filter, labelNames);
	return (
		<header className="mail-top">
			<button type="button" className="mail-button mail-sources-toggle" aria-label="Mailboxes and views" onClick={onToggleSources}>
				<ListIcon size={16} />
			</button>
			<DeckBrand />
			<div className="mail-lcd" aria-live="polite">
				<div className="mail-lcd-main">
					<p className="mail-lcd-caption">
						<i className="mail-led" aria-hidden />
						{indexing
							? `Indexing ${indexing.done}/${indexing.total}`
							: `${addressCount} addresses · ${(total ?? 0).toLocaleString()} in ${viewLabel(filter.view)}`}
					</p>
					<nav className="mail-path" aria-label="Drill path">
						{path.map((step, i) => (
							<span key={step.search} className="mail-path-step">
								{i > 0 && <span aria-hidden className="mail-path-sep">›</span>}
								{step.current ? (
									<span aria-current="page">{step.label}</span>
								) : (
									<Link to={step.search}>{step.label}</Link>
								)}
							</span>
						))}
					</nav>
				</div>
				<i className="mail-lcd-divider" aria-hidden />
				<p className="mail-lcd-number"><b>{(total ?? 0).toLocaleString()}</b>shown</p>
				<i className="mail-lcd-divider" aria-hidden />
				<p className="mail-lcd-number"><b>{(unread ?? 0).toLocaleString()}</b>unread</p>
			</div>
			<div className="mail-top-actions">
				<button type="button" className="mail-tool" onClick={onRefresh} disabled={refreshing} aria-label="Refresh">
					<span className="mail-tool-icon"><ArrowsClockwiseIcon size={15} className={refreshing ? "animate-spin" : ""} /></span>
					<span className="mail-tool-label">Refresh</span>
				</button>
				<button type="button" className="mail-tool" onClick={onToggleAgent} aria-pressed={agentOpen} aria-label="Agent">
					<span className="mail-tool-icon"><RobotIcon size={15} /></span>
					<span className="mail-tool-label">Agent</span>
				</button>
				<Link to="/settings" className="mail-tool" aria-label="Settings">
					<span className="mail-tool-icon"><GearSixIcon size={15} /></span>
					<span className="mail-tool-label">Settings</span>
				</Link>
			</div>
		</header>
	);
}
