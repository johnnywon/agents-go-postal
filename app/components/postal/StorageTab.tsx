// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { ArrowsClockwiseIcon, DatabaseIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import api, { type CopyStatusResponse, type IndexCounts, type IndexStatusResponse } from "~/services/api";

const STATE_COLUMNS = [
	["inbox", "Inbox"],
	["archive", "Archive"],
	["sent", "Sent"],
	["draft", "Drafts"],
	["trash", "Trash"],
	["spam", "Spam"],
] as const;
const SYSTEM_STATES = new Set<string>(STATE_COLUMNS.map(([state]) => state));
const ROLLBACK_DAYS = 14;

type Row = IndexStatusResponse["mailboxes"][number];

function folderCount(counts: IndexCounts | null | undefined) {
	if (!counts) return 0;
	return Object.entries(counts.states).filter(([state]) => !SYSTEM_STATES.has(state)).reduce((sum, [, n]) => sum + n, 0);
}

/** Each column's count in the address's own store and in the combined index. On D1 they are one copy. */
function columns(row: Row): { label: string; source: number; index: number; shown: boolean }[] {
	const s = row.source;
	const i = row.index;
	return [
		...STATE_COLUMNS.map(([state, label]) => ({ label, source: s?.counts.states[state] ?? 0, index: i?.states[state] ?? 0, shown: true })),
		{ label: "Unread", source: s?.counts.unread ?? 0, index: i?.unread ?? 0, shown: true },
		{ label: "Starred", source: s?.counts.starred ?? 0, index: i?.starred ?? 0, shown: true },
		{ label: "Folders", source: folderCount(s?.counts), index: folderCount(i), shown: false },
		{ label: "Inbox threads", source: s?.inboxConversations ?? 0, index: i?.inboxConversations ?? 0, shown: false },
	];
}

function rowMatches(row: Row) {
	return !row.error && !!row.source && !!row.index && columns(row).every((c) => c.source === c.index);
}

function when(iso: string) {
	return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function jobLine(job: IndexStatusResponse["job"]) {
	if (!job) return "no rebuild has run";
	if (job.error && !job.finishedAt) return `rebuild retrying at ${job.position} of ${job.mailboxes.length}: ${job.error}`;
	if (!job.finishedAt) return `rebuilding ${job.position} of ${job.mailboxes.length}`;
	return `last rebuild ${when(job.finishedAt)}`;
}

function copyLine(copy: CopyStatusResponse): string {
	const copied = copy.mailboxes.reduce((n, m) => n + m.copied, 0);
	const total = copy.mailboxes.reduce((n, m) => n + m.total, 0);
	switch (copy.state) {
		case "none":
			return "Copies every address's mail, labels and scheduled sends into D1. Mail stays where it is, and the app keeps working while it runs.";
		case "copying":
			return `Copying: ${copied.toLocaleString()} of ${total.toLocaleString()} messages.`;
		case "catching-up":
			return "Copying the mail that changed during the copy.";
		case "ready":
			return copy.parity?.ok
				? `Copied, and the counts match. To switch, set STORAGE to "d1" and deploy. Until then, changes keep copying every minute.`
				: "Copied, but some counts differ. The next run copies again.";
		case "done": {
			const until = copy.finishedAt ? new Date(Date.parse(copy.finishedAt) + ROLLBACK_DAYS * 86_400_000).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
			return `Moved to D1${copy.finishedAt ? ` ${when(copy.finishedAt)}` : ""}. New mail is also written to the old storage until ${until}.`;
		}
	}
}

function CopyToD1({ copy }: { copy: CopyStatusResponse }) {
	const queryClient = useQueryClient();
	const [confirming, setConfirming] = useState(false);
	const start = useMutation({
		mutationFn: () => api.startCopy(),
		onSuccess: () => {
			setConfirming(false);
			queryClient.invalidateQueries({ queryKey: ["copy-status"] });
		},
	});
	const off = copy.parity?.mailboxes.filter((m) => !m.ok) ?? [];
	return (
		<section className="pg-settings-section" aria-labelledby="copy-d1-heading">
			<h3 id="copy-d1-heading">Copy to D1</h3>
			<div className="pg-setting">
				<div className="pg-setting-text">
					<span>{copyLine(copy)}{copy.error && <> Last run failed: {copy.error}. The next run retries.</>}</span>
				</div>
				{copy.state === "none" && copy.storage === "durable-objects" && (confirming ? (
					<span className="pg-label-confirm">
						<button type="button" className="pg-btn pg-btn-sm pg-btn-primary" onClick={() => start.mutate()} disabled={start.isPending}>Start copy</button>
						<button type="button" className="pg-btn pg-btn-sm pg-btn-quiet" onClick={() => setConfirming(false)}>Cancel</button>
					</span>
				) : (
					<button type="button" className="pg-btn pg-btn-sm" onClick={() => setConfirming(true)}>Copy to D1</button>
				))}
			</div>
			{start.error && <p className="pg-label-note is-error" role="alert">Copy did not start: {start.error.message}</p>}
			{copy.parity && (!copy.parity.ok || copy.state !== "done") && (
				<ul className="pg-parity">
					{!copy.parity.labels.ok && <li>Labels: {copy.parity.labels.source.length} in the index, {copy.parity.labels.d1.length} in D1.</li>}
					{off.map((m) => <li key={m.mailboxId}><span className="pg-mono">{m.mailboxId}</span>: counts differ{m.pending > 0 ? `, ${m.pending.toLocaleString()} changes waiting` : ""}.</li>)}
					{copy.parity.ok && <li>All {copy.parity.mailboxes.length} addresses and {copy.parity.labels.d1.length} labels match. Checked {new Date(copy.parity.checkedAt).toLocaleTimeString()}.</li>}
				</ul>
			)}
		</section>
	);
}

/** Where the mail lives, per-address counts, the index rebuild (Durable Objects only) and the copy to D1. */
export function StorageTab() {
	const queryClient = useQueryClient();
	const status = useQuery({
		queryKey: ["index-status"],
		queryFn: () => api.getIndexStatus(),
		refetchInterval: (q) => (q.state.data?.job && !q.state.data.job.finishedAt ? 3_000 : false),
	});
	const copy = useQuery({
		queryKey: ["copy-status"],
		queryFn: () => api.getCopyStatus(),
		refetchInterval: (q) => (["copying", "catching-up", "ready"].includes(q.state.data?.state ?? "") ? 5_000 : false),
	});
	const rebuild = useMutation({
		mutationFn: () => api.rebuildIndex(),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ["index-status"] }),
	});
	const d1 = copy.data?.storage === "d1";
	const data = status.data;
	const rows = data?.mailboxes ?? [];
	const matching = rows.filter(rowMatches).length;
	const running = !!data?.job && !data.job.finishedAt;
	const heading = status.isLoading ? "Checking" : status.error ? "Could not read the counts" : d1
		? `${rows.length} ${rows.length === 1 ? "address" : "addresses"} on D1`
		: `${matching} of ${rows.length} addresses match the index`;
	const detail = data ? `${data.messages.toLocaleString()} messages${d1 ? "" : ` indexed · ${jobLine(data.job)}`}${data.probe && data.probe !== "ok" ? ` · search probe: ${data.probe}` : ""}` : "";
	const shown = rows[0] ? columns(rows[0]).filter((c) => c.shown) : [];

	return (
		<>
			<div className="pg-tab-intro">
				{d1
					? "Mail for every address is in one D1 database. Time Travel in the Cloudflare dashboard restores it to any minute in the last 30 days."
					: "Each address keeps its own mail, and a combined index merges them into one list. If counts drift, rebuild the index."}
			</div>
			<div className="pg-index-card">
				<DatabaseIcon size={18} color="var(--pg-text-5)" />
				<div className="pg-card-text">
					<b style={{ fontWeight: 600 }}>{heading}</b>
					<span>{detail}</span>
				</div>
				{!d1 && data && (
					<button type="button" className="pg-btn pg-btn-sm" onClick={() => rebuild.mutate()} disabled={rebuild.isPending || running}>
						<ArrowsClockwiseIcon size={12} />{running ? "Rebuilding" : "Rebuild"}
					</button>
				)}
			</div>
			{rebuild.isError && <p className="pg-label-note is-error" role="alert">Rebuild did not start.</p>}
			{rows.length > 0 && (
				<>
				<p className="pg-table-note" id="storage-table-note">{d1 ? "Messages per address." : "Each address's own counts beside the index. A cell that differs shows both, mailbox first."}</p>
				<div className="pg-table-scroll">
					<table className="pg-table" aria-describedby="storage-table-note">
						<thead>
							<tr>
								<th scope="col">Address</th>
								{shown.map((c) => <th scope="col" key={c.label} className="is-num">{c.label}</th>)}
								{!d1 && <th scope="col" className="is-num">Pending</th>}
							</tr>
						</thead>
						<tbody>
							{rows.map((row) => {
								const ok = d1 || rowMatches(row);
								return (
									<tr key={row.mailboxId} className={ok ? undefined : "is-off"}>
										<th scope="row">
											{!d1 && <span className="pg-parity-mark" aria-label={ok ? "Matches" : "Does not match"}>{ok ? "✓" : "≠"}</span>}
											<span className="pg-mono">{row.mailboxId}</span>
										</th>
										{row.error ? (
											<td colSpan={shown.length + (d1 ? 0 : 1)}>{row.error}</td>
										) : (
											<>
												{columns(row).filter((c) => c.shown).map((c) => (
													<td key={c.label} className={c.source === c.index || d1 ? "is-num" : "is-num is-off"}>
														{c.source === c.index || d1 ? c.source.toLocaleString() : `${c.source.toLocaleString()} ≠ ${c.index.toLocaleString()}`}
													</td>
												))}
												{!d1 && <td className="is-num">{(row.source?.pending ?? 0).toLocaleString()}</td>}
											</>
										)}
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
				</>
			)}
			{copy.data?.available && !(d1 && copy.data.state === "none") && <CopyToD1 copy={copy.data} />}
		</>
	);
}
