// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ACTIVITY_DAYS, type ActivityDays } from "shared/prefs";
import api, { type ActivityActor, type ActivityEntry, type AutoDraftRun } from "~/services/api";
import { AddressText, type Identities } from "./identity";
import { Segmented } from "./Segmented";

const ACTORS: { value: ActivityActor | "all"; label: string }[] = [
	{ value: "all", label: "All" },
	{ value: "chat", label: "Agent" },
	{ value: "auto-draft", label: "Auto-draft" },
	{ value: "mcp", label: "MCP" },
];

const ACTOR_LABELS: Record<ActivityActor, string> = { chat: "Agent", "auto-draft": "Auto-draft", mcp: "MCP" };

const ACTION_LABELS: Record<ActivityEntry["action"], string> = {
	read: "Read",
	draft: "Drafted",
	send: "Sent",
	delete: "Deleted",
	label: "Labels",
	move: "Moved",
	settings: "Settings",
};

export const RUN_LABELS: Record<AutoDraftRun["state"], string> = {
	queued: "Queued",
	running: "Running",
	drafted: "Drafted",
	skipped: "Skipped",
	superseded: "Superseded",
	failed: "Failed",
};

export const when = (iso: string) =>
	new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function ActivityEntryRow({ entry, identities }: { entry: ActivityEntry; identities: Identities }) {
	return (
		<li className="pg-activity-row" data-failed={!entry.ok || undefined}>
			<time dateTime={entry.at}>{when(entry.at)}</time>
			<div className="pg-activity-main">
				<span className="pg-activity-what">
					<b>{ACTION_LABELS[entry.action]}</b>
					{!entry.ok && <span className="pg-badge is-danger">Failed</span>}
					{entry.summary && <span className="pg-activity-summary">{entry.summary}</span>}
				</span>
				<span className="pg-activity-meta">
					<span>{ACTOR_LABELS[entry.actor]}{entry.client ? ` · ${entry.client}` : ""}</span>
					{entry.mailboxId && <AddressText address={entry.mailboxId} identity={identities.of(entry.mailboxId)} bold={false} short />}
					<span className="pg-mono">{entry.tool}</span>
				</span>
			</div>
		</li>
	);
}

/** What agents, auto-draft and MCP clients did, newest first, and the latest auto-draft runs. */
export function ActivityTab({ addresses, identities, days, onDays, autoDraft }: {
	addresses: string[];
	identities: Identities;
	days: ActivityDays;
	onDays: (days: ActivityDays) => void;
	autoDraft: boolean;
}) {
	const [mailbox, setMailbox] = useState("");
	const [actor, setActor] = useState<ActivityActor | "all">("all");
	const filter = { mailbox: mailbox || undefined, actor: actor === "all" ? undefined : actor };
	const log = useInfiniteQuery({
		queryKey: ["activity", filter],
		queryFn: ({ pageParam }) => api.getActivity({ ...filter, before: pageParam ?? undefined }),
		initialPageParam: null as number | null,
		getNextPageParam: (page) => page.next,
	});
	const runs = useQuery({ queryKey: ["auto-draft-runs", mailbox], queryFn: () => api.getAutoDraftRuns(mailbox || undefined) });
	const entries = log.data?.pages.flatMap((p) => p.entries) ?? [];

	return (
		<>
			<div className="pg-tab-intro">
				Every read, draft, send, delete and label change by the agent, auto-draft and MCP clients. Kept for {days} days.
			</div>
			<div className="pg-setting">
				<div className="pg-setting-text"><b>Keep for</b><span>Older entries are deleted once an hour.</span></div>
				<Segmented
					label="Keep activity for"
					value={String(days)}
					onChange={(v) => onDays(Number(v) as ActivityDays)}
					options={ACTIVITY_DAYS.map((d) => ({ value: String(d), label: `${d} days` }))}
				/>
			</div>
			<div className="pg-activity-filters">
				{addresses.length > 1 && (
					<select className="pg-select" value={mailbox} aria-label="Address" onChange={(e) => setMailbox(e.target.value)}>
						<option value="">All addresses</option>
						{addresses.map((a) => <option key={a} value={a}>{a}</option>)}
					</select>
				)}
				<Segmented label="Who" value={actor} onChange={setActor} options={ACTORS} />
			</div>
			{log.isPending ? <p className="pg-label-note">Loading activity</p>
				: log.error ? <p className="pg-label-note is-error" role="alert">{log.error.message}</p>
				: entries.length === 0 ? <p className="pg-label-note">No activity{mailbox || actor !== "all" ? " matches" : " yet"}.</p>
				: (
					<ul className="pg-activity-list" aria-label="Activity">
						{entries.map((e) => <ActivityEntryRow key={e.id} entry={e} identities={identities} />)}
					</ul>
				)}
			{log.hasNextPage && (
				<button type="button" className="pg-btn pg-btn-sm pg-activity-more" onClick={() => log.fetchNextPage()} disabled={log.isFetchingNextPage}>
					{log.isFetchingNextPage ? "Loading" : "Load more"}
				</button>
			)}
			{(autoDraft || (runs.data?.length ?? 0) > 0) && (
				<section className="pg-settings-section" aria-labelledby="runs-heading">
					<h3 id="runs-heading">Auto-draft runs</h3>
					{!runs.data?.length ? <p className="pg-label-note">No auto-drafts yet.</p> : (
						<div className="pg-table-scroll">
							<table className="pg-table">
								<thead>
									<tr><th scope="col">Received</th><th scope="col">From</th><th scope="col">State</th><th scope="col" className="is-num">Tries</th><th scope="col">Why</th></tr>
								</thead>
								<tbody>
									{runs.data.map((r) => (
										<tr key={r.emailId}>
											<td>{when(r.createdAt)}</td>
											<td>{r.sender}</td>
											<td>{RUN_LABELS[r.state]}</td>
											<td className="is-num">{r.attempts}</td>
											<td title={r.reason ?? undefined}>{r.reason ?? ""}</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}
				</section>
			)}
		</>
	);
}
