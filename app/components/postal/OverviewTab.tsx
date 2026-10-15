// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useQuery } from "@tanstack/react-query";
import { SEND_LIMITS } from "shared/send-limits";
import api from "~/services/api";
import { ActivityEntryRow, RUN_LABELS } from "./ActivityTab";
import type { ConsoleTab } from "./console-tabs";
import { AddressText, type Identities } from "./identity";

const RUN_ORDER = ["drafted", "skipped", "failed", "queued", "running", "superseded"] as const;

/** The last day at a glance: sends against each limit, auto-draft runs, and failed agent actions. */
export function OverviewTab({ identities, autoDraft, onTab }: { identities: Identities; autoDraft: boolean; onTab: (tab: ConsoleTab) => void }) {
	const overview = useQuery({ queryKey: ["agents-overview"], queryFn: () => api.getAgentOverview(), refetchInterval: 60_000 });
	const data = overview.data;
	if (overview.isPending) return <p className="pg-label-note pg-tab-intro">Loading</p>;
	if (overview.error || !data) return <p className="pg-label-note pg-tab-intro is-error" role="alert">{overview.error?.message ?? "Could not load the overview."}</p>;
	const agentSends = data.addresses.reduce((n, a) => n + a.agentDay, 0);
	const runs = RUN_ORDER.filter((s) => data.runs[s]).map((s) => `${data.runs[s]} ${RUN_LABELS[s].toLowerCase()}`);
	const full = (used: number, limit: number) => (limit > 0 && used >= limit ? "is-num is-full" : used === 0 ? "is-num is-zero" : "is-num");

	return (
		<>
			<div className="pg-stats">
				<button type="button" className="pg-stat" onClick={() => onTab("activity")}>
					<span>Agent actions</span><b>{data.actions.toLocaleString()}</b>
				</button>
				<button type="button" className="pg-stat" onClick={() => onTab("limits")}>
					<span>Agent sends</span><b>{agentSends.toLocaleString()}</b>
					<em>limit {data.limits.agentDay} per address</em>
				</button>
				<button type="button" className="pg-stat" onClick={() => onTab("activity")}>
					<span>Auto-drafts</span><b>{Object.values(data.runs).reduce((n, v) => n + (v ?? 0), 0)}</b>
					<em>{autoDraft ? runs.join(" · ") || "none yet" : "off"}</em>
				</button>
				<button type="button" className="pg-stat" data-bad={data.failed > 0 || undefined} onClick={() => onTab("activity")}>
					<span>Failed actions</span><b>{data.failed.toLocaleString()}</b>
				</button>
			</div>
			<div className="pg-table-scroll">
				<table className="pg-table" aria-label="Sends per address">
					<thead>
						<tr>
							<th scope="col">Address</th>
							<th scope="col" className="is-num">This hour</th>
							<th scope="col" className="is-num">Today</th>
							<th scope="col" className="is-num">By agents</th>
						</tr>
					</thead>
					<tbody>
						{data.addresses.map((a) => (
							<tr key={a.mailboxId}>
								<th scope="row"><span title={a.mailboxId}><AddressText address={a.mailboxId} identity={identities.of(a.mailboxId)} short /></span></th>
								<td className={full(a.hour, SEND_LIMITS.hour)}>{a.hour} / {SEND_LIMITS.hour}</td>
								<td className={full(a.day, SEND_LIMITS.day)}>{a.day} / {SEND_LIMITS.day}</td>
								<td className={full(a.agentDay, data.limits.agentDay)}>{a.agentDay} / {data.limits.agentDay}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
			{data.failures.length > 0 && (
				<section className="pg-settings-section" aria-labelledby="failures-heading">
					<h3 id="failures-heading">Recent failures</h3>
					<ul className="pg-activity-list">
						{data.failures.map((e) => <ActivityEntryRow key={e.id} entry={e} identities={identities} />)}
					</ul>
				</section>
			)}
		</>
	);
}
