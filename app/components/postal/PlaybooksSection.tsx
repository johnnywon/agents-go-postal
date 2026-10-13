// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { CaretDownIcon, CaretRightIcon, PlusIcon, TrashIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import api, { type Playbook, type PlaybookInput } from "~/services/api";

type Fields = Required<Pick<PlaybookInput, "name" | "whenToUse" | "instructions" | "exampleReply">>;

const EMPTY: Fields = { name: "", whenToUse: "", instructions: "", exampleReply: "" };
const fieldsOf = (p: Playbook): Fields => ({ name: p.name, whenToUse: p.whenToUse, instructions: p.instructions, exampleReply: p.exampleReply });
const same = (a: Fields, b: Fields) => a.name.trim() === b.name.trim() && a.whenToUse === b.whenToUse && a.instructions === b.instructions && a.exampleReply === b.exampleReply;

function PlaybookForm({ value, onChange, idPrefix }: { value: Fields; onChange: (v: Fields) => void; idPrefix: string }) {
	const field = (key: keyof Fields, label: string, hint: string, rows: number) => (
		<label className="pg-playbook-field" htmlFor={`${idPrefix}-${key}`}>
			<span>{label}<em>{hint}</em></span>
			{key === "name" ? (
				<input id={`${idPrefix}-${key}`} className="pg-input" value={value.name} maxLength={80} onChange={(e) => onChange({ ...value, name: e.target.value })} placeholder="Meeting requests" />
			) : (
				<textarea id={`${idPrefix}-${key}`} className="pg-textarea" rows={rows} value={value[key]} maxLength={key === "whenToUse" ? 1000 : 4000} onChange={(e) => onChange({ ...value, [key]: e.target.value })} />
			)}
		</label>
	);
	return (
		<div className="pg-playbook-form">
			{field("name", "Name", "", 1)}
			{field("whenToUse", "When to use", "The kind of email this fits", 2)}
			{field("instructions", "Instructions", "What the reply should do", 3)}
			{field("exampleReply", "Example reply", "Optional", 3)}
		</div>
	);
}

function PlaybookRow({ address, playbook }: { address: string; playbook: Playbook }) {
	const queryClient = useQueryClient();
	const [open, setOpen] = useState(false);
	const [fields, setFields] = useState<Fields>(fieldsOf(playbook));
	const [confirming, setConfirming] = useState(false);
	const refresh = () => queryClient.invalidateQueries({ queryKey: ["playbooks", address] });
	const save = useMutation({ mutationFn: () => api.updatePlaybook(address, playbook.id, { ...fields, name: fields.name.trim() }), onSuccess: refresh });
	const remove = useMutation({ mutationFn: () => api.deletePlaybook(address, playbook.id), onSuccess: refresh });
	const changed = !same(fields, fieldsOf(playbook));
	const error = save.error ?? remove.error;
	return (
		<li className="pg-playbook-row">
			<div className="pg-label-main">
				<button type="button" className="pg-playbook-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
					{open ? <CaretDownIcon size={12} /> : <CaretRightIcon size={12} />}
					<span className="pg-ellipsis">{playbook.name}</span>
				</button>
				<span className="pg-playbook-when pg-ellipsis">{playbook.whenToUse}</span>
				{confirming ? (
					<span className="pg-label-confirm">
						<button type="button" className="pg-btn pg-btn-sm pg-btn-danger" onClick={() => remove.mutate()} disabled={remove.isPending}>Delete</button>
						<button type="button" className="pg-btn pg-btn-sm pg-btn-quiet" onClick={() => setConfirming(false)}>Keep</button>
					</span>
				) : (
					<button type="button" className="pg-icon-btn" aria-label={`Delete ${playbook.name}`} title="Delete playbook" onClick={() => setConfirming(true)}>
						<TrashIcon size={14} />
					</button>
				)}
			</div>
			{open && (
				<>
					<PlaybookForm value={fields} onChange={setFields} idPrefix={`pb-${playbook.id}`} />
					<div className="pg-playbook-actions">
						<button type="button" className="pg-btn pg-btn-sm pg-btn-quiet" disabled={!changed} onClick={() => setFields(fieldsOf(playbook))}>Revert</button>
						<button type="button" className="pg-btn pg-btn-sm pg-btn-primary" disabled={!changed || !fields.name.trim() || save.isPending} onClick={() => save.mutate()}>
							{save.isPending ? "Saving" : "Save playbook"}
						</button>
					</div>
				</>
			)}
			{error && <p className="pg-label-note is-error" role="alert">{error.message}</p>}
		</li>
	);
}

/** One address's drafting playbooks. Saved as they are made, apart from the dialog's Save. */
export function PlaybooksSection({ address }: { address: string }) {
	const queryClient = useQueryClient();
	const list = useQuery({ queryKey: ["playbooks", address], queryFn: () => api.getPlaybooks(address), enabled: !!address });
	const [adding, setAdding] = useState(false);
	const [fields, setFields] = useState<Fields>(EMPTY);
	const create = useMutation({
		mutationFn: () => api.createPlaybook(address, { ...fields, name: fields.name.trim() }),
		onSuccess: () => {
			setAdding(false);
			setFields(EMPTY);
			queryClient.invalidateQueries({ queryKey: ["playbooks", address] });
		},
	});
	const playbooks = list.data ?? [];
	return (
		<section className="pg-settings-section" aria-labelledby="playbooks-heading">
			<h3 id="playbooks-heading">Playbooks</h3>
			<p className="pg-label-note pg-playbook-intro">
				Auto-draft picks the playbook that fits a new email for {address}, or none, and the draft notes which. Changes here save as you make them.
			</p>
			{list.isPending ? <p className="pg-label-note">Loading playbooks</p>
				: list.error ? <p className="pg-label-note is-error" role="alert">{list.error.message}</p>
				: playbooks.length === 0 && !adding ? <p className="pg-label-note">No playbooks for this address.</p>
				: <ul className="pg-label-list">{playbooks.map((p) => <PlaybookRow key={`${p.id}:${p.name}`} address={address} playbook={p} />)}</ul>}
			{adding ? (
				<div className="pg-playbook-new">
					<PlaybookForm value={fields} onChange={setFields} idPrefix="pb-new" />
					<div className="pg-playbook-actions">
						<button type="button" className="pg-btn pg-btn-sm pg-btn-quiet" onClick={() => { setAdding(false); setFields(EMPTY); create.reset(); }}>Cancel</button>
						<button type="button" className="pg-btn pg-btn-sm pg-btn-primary" disabled={!fields.name.trim() || create.isPending} onClick={() => create.mutate()}>
							{create.isPending ? "Adding" : "Add playbook"}
						</button>
					</div>
					{create.error && <p className="pg-label-note is-error" role="alert">{create.error.message}</p>}
				</div>
			) : (
				<button type="button" className="pg-btn pg-btn-sm pg-playbook-add" onClick={() => setAdding(true)}><PlusIcon size={12} />New playbook</button>
			)}
		</section>
	);
}
