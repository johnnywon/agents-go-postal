// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { TrashIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { useEmptyTrash, useTrashCount } from "~/queries/bulk";
import { ApiError, type BulkJobStarted, type EmptyTrashResult } from "~/services/api";

function plural(n: number, word: string) {
	return `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * Trash view only. Shows the exact message count and asks for a confirmation
 * that names it. Deletes permanently; there is no undo.
 */
export default function EmptyTrash({
	onDone, onJob, onMessage,
}: {
	onDone: (deleted: number, failed: EmptyTrashResult["failed"]) => void;
	onJob: (job: BulkJobStarted) => void;
	onMessage: (message: string) => void;
}) {
	const count = useTrashCount(true);
	const empty = useEmptyTrash();
	const [confirming, setConfirming] = useState(false);
	const slotRef = useRef<HTMLDivElement>(null);
	const keepRef = useRef<HTMLButtonElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const messages = count.data?.messages ?? 0;
	const conversations = count.data?.conversations ?? 0;

	useEffect(() => {
		if (!confirming) return;
		keepRef.current?.focus();
		const onDown = (event: MouseEvent) => {
			if (!slotRef.current?.contains(event.target as Node)) setConfirming(false);
		};
		document.addEventListener("mousedown", onDown);
		return () => document.removeEventListener("mousedown", onDown);
	}, [confirming]);

	/** Keep and Escape hand focus back to the button so keyboard users keep their place. */
	const cancel = () => {
		setConfirming(false);
		triggerRef.current?.focus();
	};

	const confirm = () => {
		const expected = messages;
		empty.mutate(expected, {
			onSuccess: (result) => {
				setConfirming(false);
				if ("jobId" in result) onJob(result);
				else onDone(result.deleted, result.failed);
			},
			onError: (error) => {
				setConfirming(false);
				if (error instanceof ApiError && error.status === 409) {
					onMessage(`Trash changed: ${plural(Number(error.body.count ?? 0), "message")} now. Nothing was deleted.`);
					count.refetch();
				} else {
					onMessage(`Could not empty Trash. ${(error as Error).message}`);
				}
			},
		});
	};

	return (
		<div className="mail-scope-slot mail-empty-trash" ref={slotRef}>
			<button
				ref={triggerRef}
				type="button"
				className="mail-button"
				aria-expanded={confirming}
				aria-haspopup="dialog"
				disabled={count.isPending || messages === 0 || empty.isPending}
				onClick={() => setConfirming((v) => !v)}
			>
				<TrashIcon size={13} /> Empty Trash
				{count.data && <b className="mail-empty-trash-count">{messages.toLocaleString()}</b>}
			</button>
			{confirming && (
				<div
					className="mail-popover mail-confirm"
					role="alertdialog"
					aria-labelledby="empty-trash-text"
					data-mail-popover
					onKeyDown={(event) => {
						if (event.key !== "Escape") return;
						event.preventDefault();
						cancel();
					}}
				>
					<p id="empty-trash-text">
						Delete {plural(messages, "message")} in {plural(conversations, "conversation")} forever?
						This cannot be undone.
					</p>
					<div className="mail-popover-foot">
						<button ref={keepRef} type="button" className="mail-link" onClick={cancel}>Keep</button>
						<button type="button" className="mail-button" onClick={confirm} disabled={empty.isPending}>
							Delete forever
						</button>
					</div>
				</div>
			)}
		</div>
	);
}
