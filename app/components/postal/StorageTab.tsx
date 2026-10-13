// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { DatabaseIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import api from "~/services/api";
import { AddressText, type Identities } from "./identity";

const STATE_COLUMNS = [
	["inbox", "Inbox"],
	["archive", "Archive"],
	["sent", "Sent"],
	["draft", "Drafts"],
	["trash", "Trash"],
	["spam", "Spam"],
] as const;

/** Where the mail lives, and each address's message counts. */
export function StorageTab({ identities }: { identities: Identities }) {
	const status = useQuery({ queryKey: ["storage-status"], queryFn: () => api.getStorageStatus() });
	const data = status.data;
	const rows = data?.mailboxes ?? [];
	const heading = status.isLoading ? "Checking" : status.error ? "Could not read the counts"
		: `${rows.length} ${rows.length === 1 ? "address" : "addresses"} on D1`;
	const columns: { label: string; count: (row: (typeof rows)[number]) => number }[] = [
		...STATE_COLUMNS.map(([state, label]) => ({ label, count: (row: (typeof rows)[number]) => row.states[state] ?? 0 })),
		{ label: "Unread", count: (row) => row.unread },
		{ label: "Starred", count: (row) => row.starred },
	];

	return (
		<>
			<div className="pg-tab-intro">
				Mail for every address is in one D1 database. Time Travel in the Cloudflare dashboard restores it to any minute in the last 30 days.
			</div>
			<div className="pg-index-card">
				<DatabaseIcon size={18} color="var(--pg-text-5)" />
				<div className="pg-card-text">
					<b style={{ fontWeight: 600 }}>{heading}</b>
					<span>{data ? `${data.messages.toLocaleString()} messages` : ""}</span>
				</div>
			</div>
			{rows.length > 0 && (
				<>
				<p className="pg-table-note" id="storage-table-note">Messages per address.</p>
				<div className="pg-table-scroll">
					<table className="pg-table" aria-describedby="storage-table-note">
						<thead>
							<tr>
								<th scope="col">Address</th>
								{columns.map((c) => <th scope="col" key={c.label} className="is-num">{c.label}</th>)}
							</tr>
						</thead>
						<tbody>
							{rows.map((row) => (
								<tr key={row.mailboxId}>
									<th scope="row">
										<span title={row.mailboxId}><AddressText address={row.mailboxId} identity={identities.of(row.mailboxId)} short /></span>
									</th>
									{columns.map((c) => {
										const n = c.count(row);
										return <td key={c.label} className={n === 0 ? "is-num is-zero" : "is-num"}>{n.toLocaleString()}</td>;
									})}
								</tr>
							))}
						</tbody>
					</table>
				</div>
				</>
			)}
		</>
	);
}
