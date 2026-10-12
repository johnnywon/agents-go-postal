// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { PlusIcon, TrashIcon } from "@phosphor-icons/react";
import { type FormEvent, useState } from "react";
import { LABEL_COLORS } from "shared/label-colors";
import { LabelSwatch } from "~/components/LabelChip";
import { type Label, useCreateLabel, useDeleteLabel, useLabels, useUpdateLabel } from "~/queries/labels";
import api from "~/services/api";

function ColorPicker({ value, onChange, name }: { value: string; onChange: (color: string) => void; name: string }) {
	return (
		<div className="pg-colors" role="radiogroup" aria-label={`Colour for ${name}`}>
			{LABEL_COLORS.map((c) => (
				<button key={c.bg} type="button" role="radio" aria-checked={value === c.bg} aria-label={c.name} title={c.name} className="pg-color" onClick={() => onChange(c.bg)}>
					<LabelSwatch color={c.bg} />
				</button>
			))}
		</div>
	);
}

function LabelRow({ label }: { label: Label }) {
	const update = useUpdateLabel();
	const remove = useDeleteLabel();
	const [name, setName] = useState(label.name);
	const [color, setColor] = useState(false);
	const [confirming, setConfirming] = useState(false);
	const save = (event?: FormEvent) => {
		event?.preventDefault();
		const next = name.trim();
		if (next && next !== label.name) update.mutate({ id: label.id, name: next });
		else setName(label.name);
	};
	const error = update.error ?? remove.error;
	return (
		<li className="pg-label-row">
			<div className="pg-label-main">
				<button type="button" className="pg-color pg-label-color" aria-expanded={color} aria-label={`Change colour of ${label.name}`} title="Colour" onClick={() => setColor(!color)}>
					<LabelSwatch color={label.color} />
				</button>
				<form onSubmit={save} className="pg-flex">
					<input className="pg-input pg-label-name" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => save()} aria-label={`Name of ${label.name}`} maxLength={60} />
				</form>
				<span className="pg-label-count">{label.count.toLocaleString()}</span>
				{confirming ? (
					<span className="pg-label-confirm">
						<button type="button" className="pg-btn pg-btn-sm pg-btn-danger" onClick={() => remove.mutate(label.id)} disabled={remove.isPending}>Delete</button>
						<button type="button" className="pg-btn pg-btn-sm pg-btn-quiet" onClick={() => setConfirming(false)}>Keep</button>
					</span>
				) : (
					<button type="button" className="pg-icon-btn" aria-label={`Delete ${label.name}`} title="Delete label" onClick={() => setConfirming(true)}>
						<TrashIcon size={14} />
					</button>
				)}
			</div>
			{confirming && <p className="pg-label-note">Removes {label.name} from {label.count.toLocaleString()} {label.count === 1 ? "conversation" : "conversations"}. The mail stays.</p>}
			{color && <ColorPicker name={label.name} value={label.color} onChange={(c) => { update.mutate({ id: label.id, color: c }); setColor(false); }} />}
			{error && <p className="pg-label-note is-error" role="alert">{error.message}</p>}
		</li>
	);
}

/** Convert custom folders to labels. Counts first; converting backs up to R2, labels each folder's mail and archives it. Folders are kept. */
function FolderImport() {
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
	const error = dryRun.error ?? run.error;
	return (
		<section className="pg-settings-section" aria-labelledby="folders-heading">
			<h3 id="folders-heading">Folders to labels</h3>
			<div className="pg-setting">
				<div className="pg-setting-text">
					<span>Each custom folder becomes a label of the same name. Its mail gets the label and moves to Archive. Folders are kept.</span>
				</div>
				{dryRun.data && !run.data && dryRun.data.totals.folders > 0 ? (
					confirming ? (
						<span className="pg-label-confirm">
							<button type="button" className="pg-btn pg-btn-sm pg-btn-primary" onClick={() => { setConfirming(false); run.mutate(); }}>Convert</button>
							<button type="button" className="pg-btn pg-btn-sm pg-btn-quiet" onClick={() => setConfirming(false)}>Cancel</button>
						</span>
					) : (
						<button type="button" className="pg-btn pg-btn-sm" onClick={() => setConfirming(true)} disabled={run.isPending}>{run.isPending ? "Converting" : "Convert"}</button>
					)
				) : (
					<button type="button" className="pg-btn pg-btn-sm" onClick={() => dryRun.mutate()} disabled={dryRun.isPending || run.isPending}>{dryRun.isPending ? "Counting" : "Count folders"}</button>
				)}
			</div>
			{confirming && dryRun.data && <p className="pg-label-note">Labels {dryRun.data.totals.messages.toLocaleString()} messages in {dryRun.data.totals.folders} folders and moves them to Archive.</p>}
			{error && <p className="pg-label-note is-error" role="alert">{error.message}</p>}
			{plan && (plan.totals.folders === 0 ? <p className="pg-label-note">No custom folders.</p> : (
				<>
				<p className="pg-table-note" id="folders-table-note">
					{plan.totals.mailboxes} addresses · {plan.totals.folders} folders · {plan.totals.messages.toLocaleString()} messages
					{run.data && <> · backup <span className="pg-mono">{run.data.backup}</span></>}
				</p>
				<div className="pg-table-scroll">
					<table className="pg-table" aria-describedby="folders-table-note">
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
										<td className="is-num">{f.count.toLocaleString()}</td>
										{results && <td>{result?.error ? `Failed: ${result.error}` : `${result?.labeled ?? 0} labeled, ${result?.archived ?? 0} archived`}</td>}
									</tr>
								);
							}))}
						</tbody>
					</table>
				</div>
				</>
			))}
		</section>
	);
}

/** Labels shared by every address. Changes save as they are made, apart from the dialog's Save. */
export function LabelsTab() {
	const { labels, isPending } = useLabels();
	const create = useCreateLabel();
	const [name, setName] = useState("");
	const [color, setColor] = useState<string>(LABEL_COLORS[5].bg);
	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (!name.trim()) return;
		create.mutate({ name: name.trim(), color }, { onSuccess: () => setName("") });
	};
	return (
		<>
			<div className="pg-tab-intro">Labels are tags shared by every address. Labeling leaves a conversation where it is. Changes here save as you make them.</div>
			<form className="pg-label-new" onSubmit={submit}>
				<div className="pg-label-main">
					<span className="pg-color pg-label-color" aria-hidden><LabelSwatch color={color} /></span>
					<input className="pg-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="New label" aria-label="New label name" maxLength={60} />
					<button type="submit" className="pg-btn pg-btn-sm" disabled={!name.trim() || create.isPending}><PlusIcon size={12} />Create</button>
				</div>
				<ColorPicker name="the new label" value={color} onChange={setColor} />
				{create.error && <p className="pg-label-note is-error" role="alert">{create.error.message}</p>}
			</form>
			{isPending ? <p className="pg-label-note">Loading labels</p> : labels.length === 0 ? <p className="pg-label-note">No labels yet.</p> : (
				<>
					<div className="pg-label-head"><span>Label</span><span>Conversations</span></div>
					<ul className="pg-label-list">{labels.map((l) => <LabelRow key={`${l.id}:${l.name}`} label={l} />)}</ul>
				</>
			)}
			<FolderImport />
		</>
	);
}
