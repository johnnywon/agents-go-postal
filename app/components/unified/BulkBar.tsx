// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { ArchiveIcon, CaretDownIcon, EnvelopeOpenIcon, EnvelopeSimpleIcon, StarIcon, TagIcon, TrashIcon, XIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { type MoveFolder, moveTargets } from "~/lib/bulk-optimistic";

export const FOLDER_NAMES: Record<MoveFolder, string> = { inbox: "Inbox", archive: "Archive", spam: "Spam", trash: "Trash" };

/** Replaces the scope bar while rows are checked. */
export default function BulkBar({
	view, count, total, allMatching, onClear, onSelectAllMatching, onArchive, onDelete, onRead, readAction, onStar, starAction,
	onLabel, labelOpen, onMove, picker,
}: {
	view: string;
	count: number;
	total: number;
	allMatching: boolean;
	onClear: () => void;
	onSelectAllMatching: () => void;
	onArchive: () => void;
	/** Null in the Trash view, where Empty Trash takes over. */
	onDelete: (() => void) | null;
	onRead: () => void;
	readAction: "read" | "unread";
	onStar: () => void;
	starAction: "star" | "unstar";
	onLabel: () => void;
	labelOpen: boolean;
	onMove: (folder: MoveFolder) => void;
	picker?: React.ReactNode;
}) {
	const [moreOpen, setMoreOpen] = useState(false);
	const moreRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!moreOpen) return;
		const onDown = (event: MouseEvent) => {
			if (!moreRef.current?.contains(event.target as Node)) setMoreOpen(false);
		};
		document.addEventListener("mousedown", onDown);
		return () => document.removeEventListener("mousedown", onDown);
	}, [moreOpen]);

	return (
		<div className="mail-scope mail-bulk" role="toolbar" aria-label="Selected conversations">
			<button type="button" className="mail-button" aria-label="Clear selection" onClick={onClear}>
				<XIcon size={12} weight="bold" />
			</button>
			<b className="mail-bulk-count" aria-live="polite">{count.toLocaleString()} selected</b>
			{!allMatching && total > count && (
				<button type="button" className="mail-link" onClick={onSelectAllMatching}>
					Select all {total.toLocaleString()} matching
				</button>
			)}
			<span className="mail-scope-divider" aria-hidden />
			<button type="button" className="mail-button" onClick={onArchive}>
				<ArchiveIcon size={13} /> Archive
			</button>
			{onDelete && (
				<button type="button" className="mail-button" onClick={onDelete}>
					<TrashIcon size={13} /> Delete
				</button>
			)}
			<button type="button" className="mail-button" onClick={onRead}>
				{readAction === "read" ? <EnvelopeOpenIcon size={13} /> : <EnvelopeSimpleIcon size={13} />}
				{readAction === "read" ? "Read" : "Unread"}
			</button>
			<button type="button" className="mail-button" onClick={onStar}>
				<StarIcon size={13} weight={starAction === "star" ? "regular" : "fill"} />
				{starAction === "star" ? "Star" : "Unstar"}
			</button>
			<div className="mail-scope-slot">
				<button type="button" className="mail-button" data-label-anchor aria-expanded={labelOpen} onClick={onLabel}>
					<TagIcon size={13} /> Label
				</button>
				{picker}
			</div>
			<div className="mail-scope-slot" ref={moreRef}>
				<button type="button" className="mail-button" aria-expanded={moreOpen} aria-haspopup="menu" onClick={() => setMoreOpen((v) => !v)}>
					More <CaretDownIcon size={11} weight="bold" aria-hidden />
				</button>
				{moreOpen && (
					<div className="mail-popover mail-menu" role="menu" data-mail-popover>
						<p className="mail-caption mail-popover-heading">Move to</p>
						{moveTargets(view).map((folder) => (
							<button key={folder} type="button" role="menuitem" className="mail-popover-item" onClick={() => { setMoreOpen(false); onMove(folder); }}>
								<span className="mail-popover-label">{FOLDER_NAMES[folder]}</span>
							</button>
						))}
					</div>
				)}
			</div>
		</div>
	);
}
