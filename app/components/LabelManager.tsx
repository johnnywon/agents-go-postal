// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { type FormEvent, useState } from "react";
import { LABEL_COLORS } from "shared/label-colors";
import { LabelChip, LabelSwatch } from "~/components/unified/LabelChip";
import { type Label, useCreateLabel, useDeleteLabel, useLabels, useUpdateLabel } from "~/queries/labels";

function ColorPicker({ value, onChange, name }: { value: string; onChange: (color: string) => void; name: string }) {
	return (
		<div className="label-colors" role="radiogroup" aria-label={`Colour for ${name}`}>
			{LABEL_COLORS.map((c) => (
				<button
					key={c.bg}
					type="button"
					role="radio"
					aria-checked={value === c.bg}
					aria-label={c.name}
					title={c.name}
					className="label-color"
					onClick={() => onChange(c.bg)}
				>
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
	const [confirming, setConfirming] = useState(false);
	const save = (event: FormEvent) => {
		event.preventDefault();
		if (name.trim() && name.trim() !== label.name) update.mutate({ id: label.id, name: name.trim() });
	};
	return (
		<li className="label-row">
			<form onSubmit={save} className="label-row-main">
				<LabelChip label={{ name: name || label.name, color: label.color }} />
				<input value={name} onChange={(e) => setName(e.target.value)} onBlur={save} aria-label={`Name of ${label.name}`} maxLength={60} />
				<span className="label-row-count">{label.count.toLocaleString()} conversations</span>
			</form>
			<ColorPicker name={label.name} value={label.color} onChange={(color) => update.mutate({ id: label.id, color })} />
			{confirming ? (
				<span className="label-row-confirm">
					Remove from {label.count.toLocaleString()} conversations and delete?
					<button type="button" className="mail-button" onClick={() => remove.mutate(label.id)} disabled={remove.isPending}>Delete</button>
					<button type="button" className="mail-link" onClick={() => setConfirming(false)}>Keep</button>
				</span>
			) : (
				<button type="button" className="mail-link" onClick={() => setConfirming(true)}>Delete</button>
			)}
			{(update.error || remove.error) && <p className="label-error" role="alert">{(update.error ?? remove.error)!.message}</p>}
		</li>
	);
}

/** Labels shared by every address: create, rename, recolour, delete. */
export default function LabelManager() {
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
		<section className="settings-section label-manager" aria-labelledby="labels-heading">
			<h2 id="labels-heading" className="mail-caption">Labels</h2>
			<p className="settings-note">Labels are tags. Labeling leaves a conversation where it is.</p>
			{isPending ? <p>Loading</p> : labels.length === 0 ? <p className="settings-note">No labels yet.</p> : (
				<ul className="label-list">{labels.map((l) => <LabelRow key={`${l.id}:${l.name}`} label={l} />)}</ul>
			)}
			<form className="label-new" onSubmit={submit}>
				<input value={name} onChange={(e) => setName(e.target.value)} placeholder="New label" aria-label="New label name" maxLength={60} />
				<ColorPicker name="the new label" value={color} onChange={setColor} />
				<button type="submit" className="mail-button" disabled={!name.trim() || create.isPending}>Create</button>
			</form>
			{create.error && <p className="label-error" role="alert">{create.error.message}</p>}
		</section>
	);
}
