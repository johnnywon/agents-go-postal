// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	ArchiveIcon,
	EnvelopeSimpleIcon,
	FileIcon,
	FolderIcon,
	PaperPlaneTiltIcon,
	StarIcon,
	TrashIcon,
	TrayIcon,
	WarningIcon,
} from "@phosphor-icons/react";
import type { ComponentType } from "react";
import { viewLabel } from "~/lib/mail-filter";
import type { Label } from "~/services/api";
import { LabelSwatch } from "./LabelChip";

const VIEWS: { view: string; icon: ComponentType<{ size?: number }>; counted?: boolean }[] = [
	{ view: "inbox", icon: TrayIcon, counted: true },
	{ view: "unread", icon: EnvelopeSimpleIcon, counted: true },
	{ view: "starred", icon: StarIcon, counted: true },
	{ view: "drafts", icon: FileIcon },
	{ view: "sent", icon: PaperPlaneTiltIcon },
	{ view: "archive", icon: ArchiveIcon },
	{ view: "spam", icon: WarningIcon },
	{ view: "trash", icon: TrashIcon },
];

export default function SourceList({
	view, counts, folders, onView, open, labels, activeLabels, onLabel,
}: {
	view: string;
	counts: Record<string, number | undefined>;
	folders: { view: string; count: number }[];
	onView: (view: string) => void;
	open: boolean;
	labels: Label[];
	activeLabels: string[];
	onLabel: (id: string) => void;
}) {
	const row = (target: string, Icon: ComponentType<{ size?: number }>, count?: number) => (
		<button
			key={target}
			type="button"
			className="mail-source"
			aria-current={view === target ? "page" : undefined}
			onClick={() => onView(target)}
		>
			<Icon size={15} />
			<span>{viewLabel(target)}</span>
			{count !== undefined && <b>{count.toLocaleString()}</b>}
		</button>
	);
	return (
		<nav className={`mail-sources${open ? " is-open" : ""}`} aria-label="Views">
			<p className="mail-caption">Mailboxes</p>
			{VIEWS.map(({ view: v, icon, counted }) => row(v, icon, counted ? counts[v] : undefined))}
			{labels.length > 0 && (
				<>
					<p className="mail-caption">Labels</p>
					{labels.map((l) => (
						<button
							key={l.id}
							type="button"
							className={`mail-source${l.count === 0 ? " is-zero" : ""}`}
							aria-pressed={activeLabels.includes(l.id)}
							onClick={() => onLabel(l.id)}
						>
							<LabelSwatch color={l.color} />
							<span>{l.name}</span>
							<b>{l.count.toLocaleString()}</b>
						</button>
					))}
				</>
			)}
			{folders.length > 0 && (
				<>
					<p className="mail-caption">Folders</p>
					{folders.map((f) => row(f.view, FolderIcon, f.count))}
				</>
			)}
		</nav>
	);
}
