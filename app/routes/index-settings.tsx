// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Loader, useKumoToastManager } from "@cloudflare/kumo";
import { ArrowsClockwiseIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import DeckBrand from "~/components/DeckBrand";
import api, { type CopyStatusResponse, type IndexCounts, type IndexStatusResponse } from "~/services/api";
import { pageTitle } from "~/lib/brand";

export function meta({ matches }: { matches: Parameters<typeof pageTitle>[0] }) {
	return [{ title: pageTitle(matches, "Index") }];
}

const STATE_COLUMNS = [
	["inbox", "Inbox"],
	["archive", "Archive"],
	["sent", "Sent"],
	["draft", "Drafts"],
	["trash", "Trash"],
	["spam", "Spam"],
] as const;
const SYSTEM_STATES = new Set<string>(STATE_COLUMNS.map(([state]) => state));

function folderCount(counts: IndexCounts | null | undefined) {
	if (!counts) return 0;
	return Object.entries(counts.states)
		.filter(([state]) => !SYSTEM_STATES.has(state))
		.reduce((sum, [, n]) => sum + n, 0);
}

type Row = IndexStatusResponse["mailboxes"][number];

function columns(row: Row): { label: string; source: number; index: number }[] {
	const s = row.source;
	const i = row.index;
	return [
		...STATE_COLUMNS.map(([state, label]) => ({ label, source: s?.counts.states[state] ?? 0, index: i?.states[state] ?? 0 })),
		{ label: "Folders", source: folderCount(s?.counts), index: folderCount(i) },
		{ label: "Unread", source: s?.counts.unread ?? 0, index: i?.unread ?? 0 },
		{ label: "Starred", source: s?.counts.starred ?? 0, index: i?.starred ?? 0 },
		{ label: "Inbox threads", source: s?.inboxConversations ?? 0, index: i?.inboxConversations ?? 0 },
	];
}

function rowMatches(row: Row) {
	return !row.error && columns(row).every((c) => c.source === c.index);
}

function jobLine(job: IndexStatusResponse["job"]) {
	if (!job) return "No rebuild has run.";
	if (job.error && !job.finishedAt) return `Rebuild retrying at ${job.position} of ${job.mailboxes.length}: ${job.error}`;
	if (!job.finishedAt) return `Rebuilding ${job.position} of ${job.mailboxes.length} addresses.`;
	return `Last rebuild finished ${new Date(job.finishedAt).toLocaleString()}.`;
}

const ROLLBACK_DAYS = 14;

function copyLine(copy: CopyStatusResponse): string {
	const copied = copy.mailboxes.reduce((n, m) => n + m.copied, 0);
	const total = copy.mailboxes.reduce((n, m) => n + m.total, 0);
	switch (copy.state) {
		case "none":
			return copy.storage === "d1"
				? "This deployment runs on D1."
				: "Copies every address's mail, labels and scheduled sends into the D1 database. The mail stays where it is, and the app keeps working while it runs.";
		case "copying":
			return `Copying: ${copied.toLocaleString()} of ${total.toLocaleString()} messages.`;
		case "catching-up":
			return "Copying the mail that changed during the copy.";
		case "ready":
			return copy.parity?.ok
				? `Copied, and the counts match. To switch, set STORAGE to "d1" and deploy. Until then, changes keep copying every minute.`
				: "Copied, but some counts differ. The next run copies again; the table below shows where.";
		case "done": {
			const until = copy.finishedAt ? new Date(Date.parse(copy.finishedAt) + ROLLBACK_DAYS * 86_400_000).toLocaleDateString() : "";
			return `Moved to D1${copy.finishedAt ? ` on ${new Date(copy.finishedAt).toLocaleString()}` : ""}. New mail is also written to the old storage until ${until}.`;
		}
	}
}

function CopyToD1() {
	const toastManager = useKumoToastManager();
	const queryClient = useQueryClient();
	const [confirming, setConfirming] = useState(false);
	const { data } = useQuery({
		queryKey: ["copy-status"],
		queryFn: () => api.getCopyStatus(),
		refetchInterval: (query) => (["copying", "catching-up", "ready"].includes(query.state.data?.state ?? "") ? 5_000 : false),
	});
	const start = useMutation({
		mutationFn: () => api.startCopy(),
		onSuccess: () => {
			setConfirming(false);
			queryClient.invalidateQueries({ queryKey: ["copy-status"] });
		},
		onError: (e) => toastManager.add({ title: "Copy did not start", description: (e as Error).message, variant: "error" }),
	});
	if (!data?.available) return null;
	const off = data.parity?.mailboxes.filter((m) => !m.ok) ?? [];
	return (
		<section className="copy-d1" aria-labelledby="copy-d1-title">
			<h2 id="copy-d1-title" className="text-base font-semibold">Copy to D1</h2>
			<div className="index-settings-summary">
				<p>{copyLine(data)}{data.error && <> Last run failed: {data.error}. The next run retries.</>}</p>
				{data.state === "none" && data.storage === "durable-objects" && (
					confirming ? (
						<span className="copy-d1-confirm">
							<Button variant="primary" onClick={() => start.mutate()} loading={start.isPending}>Start copy</Button>
							<Button variant="secondary" onClick={() => setConfirming(false)}>Cancel</Button>
						</span>
					) : (
						<Button onClick={() => setConfirming(true)}>Copy to D1</Button>
					)
				)}
			</div>
			{data.parity && (!data.parity.ok || data.state !== "done") && (
				<ul className="copy-d1-parity">
					{!data.parity.labels.ok && <li>Labels: {data.parity.labels.source.length} in the index, {data.parity.labels.d1.length} in D1.</li>}
					{off.map((m) => <li key={m.mailboxId}>{m.mailboxId}: counts differ{m.pending > 0 ? `, ${m.pending.toLocaleString()} changes waiting` : ""}.</li>)}
					{data.parity.ok && <li>All {data.parity.mailboxes.length} addresses and {data.parity.labels.d1.length} labels match. Checked {new Date(data.parity.checkedAt).toLocaleTimeString()}.</li>}
				</ul>
			)}
		</section>
	);
}

export default function IndexSettingsRoute() {
	const toastManager = useKumoToastManager();
	const queryClient = useQueryClient();
	const { data, isLoading, error } = useQuery({
		queryKey: ["index-status"],
		queryFn: () => api.getIndexStatus(),
		refetchInterval: (query) => (query.state.data?.job && !query.state.data.job.finishedAt ? 3_000 : false),
	});
	const rebuild = useMutation({
		mutationFn: () => api.rebuildIndex(),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ["index-status"] }),
		onError: () => toastManager.add({ title: "Rebuild failed to start", variant: "error" }),
	});

	const rows = data?.mailboxes ?? [];
	const matching = rows.filter(rowMatches).length;
	const rebuilding = !!data?.job && !data.job.finishedAt;

	return (
		<div className="index-settings">
			<header className="index-settings-header">
				<DeckBrand />
			</header>
			<main className="settings-page index-settings-page">
				<h1 className="text-lg font-semibold">Mail index</h1>
				<p className="index-settings-lede">
					Each address's own counts beside the combined index. Mismatched cells show both numbers, mailbox first.
				</p>
				{isLoading && <Loader size="lg" />}
				{error && <p role="alert">Could not load index status.</p>}
				{data && (
					<>
						<div className="index-settings-summary">
							<p>
								<strong>{matching.toLocaleString()} of {rows.length.toLocaleString()} addresses match.</strong>{" "}
								{data.messages.toLocaleString()} {data.messages === 1 ? "message" : "messages"} indexed. {jobLine(data.job)}
								{data.probe && data.probe !== "ok" && <> Search probe: {data.probe}.</>}
							</p>
							<Button
								icon={<ArrowsClockwiseIcon size={16} />}
								onClick={() => rebuild.mutate()}
								loading={rebuild.isPending}
								disabled={rebuilding}
							>
								Rebuild
							</Button>
						</div>
						<div className="index-parity-scroll">
							<table className="index-parity">
								<thead>
									<tr>
										<th scope="col">Address</th>
										{columns(rows[0] ?? { mailboxId: "", index: null }).map((c) => (
											<th scope="col" key={c.label}>{c.label}</th>
										))}
										<th scope="col">Pending</th>
									</tr>
								</thead>
								<tbody>
									{rows.map((row) => {
										const ok = rowMatches(row);
										return (
											<tr key={row.mailboxId} className={ok ? undefined : "is-off"}>
												<th scope="row">
													<span aria-label={ok ? "Matches" : "Does not match"} className="index-parity-mark">
														{ok ? "✓" : "≠"}
													</span>
													{row.mailboxId}
												</th>
												{row.error ? (
													<td colSpan={STATE_COLUMNS.length + 4}>{row.error}</td>
												) : (
													columns(row).map((c) => (
														<td key={c.label} className={c.source === c.index ? undefined : "is-off"}>
															{c.source === c.index
																? c.source.toLocaleString()
																: `${c.source.toLocaleString()} ≠ ${c.index.toLocaleString()}`}
														</td>
													))
												)}
												<td>{(row.source?.pending ?? 0).toLocaleString()}</td>
											</tr>
										);
									})}
								</tbody>
							</table>
						</div>
					</>
				)}
				<CopyToD1 />
			</main>
		</div>
	);
}
