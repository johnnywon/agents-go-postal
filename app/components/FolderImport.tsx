// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import api from "~/services/api";

/**
 * Convert custom folders to labels. Count first; converting backs up to R2,
 * labels each folder's mail, then moves it to Archive. Folders are kept.
 */
export default function FolderImport() {
	const queryClient = useQueryClient();
	const dryRun = useMutation({ mutationFn: () => api.importFoldersDryRun() });
	const run = useMutation({
		mutationFn: () => api.importFolders(),
		onSettled: () => {
			for (const key of [["labels"], ["mail"], ["mail-facets"], ["folders"]]) queryClient.invalidateQueries({ queryKey: key });
		},
	});
	const [confirming, setConfirming] = useState(false);
	const plan = run.data?.plan ?? dryRun.data;
	const results = run.data?.results;

	return (
		<section className="settings-section folder-import" aria-labelledby="folders-heading">
			<h2 id="folders-heading" className="mail-caption">Folders to labels</h2>
			<p className="settings-note">
				Each custom folder becomes a label of the same name. Its mail gets the label and moves to Archive. Folders are not deleted.
			</p>
			<div className="folder-import-actions">
				<button type="button" className="mail-button" onClick={() => dryRun.mutate()} disabled={dryRun.isPending || run.isPending}>
					{dryRun.isPending ? "Counting" : "Count folders"}
				</button>
				{dryRun.data && !run.data && dryRun.data.totals.folders > 0 && (confirming ? (
					<span className="label-row-confirm">
						Label {dryRun.data.totals.messages.toLocaleString()} messages in {dryRun.data.totals.folders} folders and move them to Archive?
						<button type="button" className="mail-button" onClick={() => { setConfirming(false); run.mutate(); }}>Convert</button>
						<button type="button" className="mail-link" onClick={() => setConfirming(false)}>Cancel</button>
					</span>
				) : (
					<button type="button" className="mail-button" onClick={() => setConfirming(true)} disabled={run.isPending}>
						{run.isPending ? "Converting" : "Convert"}
					</button>
				))}
			</div>
			{(dryRun.error || run.error) && <p className="label-error" role="alert">{(dryRun.error ?? run.error)!.message}</p>}
			{plan && (plan.totals.folders === 0 ? <p className="settings-note">No custom folders.</p> : (
				<table className="folder-import-table">
					<caption className="settings-note">
						{plan.totals.mailboxes} addresses · {plan.totals.folders} folders · {plan.totals.messages.toLocaleString()} messages
						{run.data && <> · backup <code>{run.data.backup}</code></>}
					</caption>
					<thead>
						<tr><th scope="col">Address</th><th scope="col">Folder</th><th scope="col">Label</th><th scope="col">Messages</th>{results && <th scope="col">Result</th>}</tr>
					</thead>
					<tbody>
						{plan.mailboxes.flatMap((m) => m.folders.map((f) => {
							const result = results?.find((r) => r.mailboxId === m.mailboxId && r.folderId === f.folderId);
							const label = plan.labels.find((l) => l.id === f.labelId);
							return (
								<tr key={`${m.mailboxId}/${f.folderId}`}>
									<td>{m.mailboxId}</td>
									<td>{f.name}</td>
									<td>{label?.name ?? f.labelId}{label?.exists ? " (exists)" : ""}</td>
									<td>{f.count.toLocaleString()}</td>
									{results && <td>{result?.error ? `Failed: ${result.error}` : `${result?.labeled ?? 0} labeled, ${result?.archived ?? 0} archived`}</td>}
								</tr>
							);
						}))}
					</tbody>
				</table>
			))}
		</section>
	);
}
