// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { TagIcon, XIcon } from "@phosphor-icons/react";
import { useEffect, useRef } from "react";
import ComposePanel from "~/components/ComposePanel";
import EmailPanel from "~/components/EmailPanel";
import { useUIStore } from "~/hooks/useUIStore";
import type { OpenRef } from "~/lib/mail-filter";
import { useEmail, useMarkThreadRead, useUpdateEmail } from "~/queries/emails";
import type { Conversation, Label } from "~/services/api";
import type { Email } from "~/types";
import { LabelChip } from "./LabelChip";

const FOLDER_OF_STATE: Record<string, string> = { draft: "draft" };

function folderFor(state: string | undefined) {
	if (!state) return undefined;
	if (state.startsWith("folder:")) return state.slice(7);
	return FOLDER_OF_STATE[state] ?? state;
}

/** Address picker for new mail, grouped by domain. */
export function FromSelect({ addresses, value, onChange }: { addresses: string[]; value: string; onChange: (address: string) => void }) {
	const domains = [...new Set(addresses.map((a) => a.slice(a.lastIndexOf("@") + 1)))];
	return (
		<label className="mail-from">
			<span className="mail-caption">From</span>
			<select required value={value} onChange={(e) => onChange(e.target.value)} aria-label="Send from">
				{domains.map((domain) => (
					<optgroup key={domain} label={domain}>
						{addresses.filter((a) => a.endsWith(`@${domain}`)).map((a) => (
							<option key={a} value={a}>{a}</option>
						))}
					</optgroup>
				))}
			</select>
		</label>
	);
}

/**
 * The reader slot: the open conversation, or the composer. Replies open at
 * the foot of the conversation with From locked to its address; forwards and
 * draft edits take the whole slot.
 */
/** The open conversation's labels, with remove buttons and the Label picker button. */
function ReaderLabels({ row, labels, onLabel, onRemoveLabel, pickerOpen }: {
	row: Conversation;
	labels: ReadonlyMap<string, Label>;
	onLabel: () => void;
	onRemoveLabel: (labelId: string) => void;
	pickerOpen: boolean;
}) {
	const rowLabels = row.labels.map((id) => labels.get(id)).filter((l): l is Label => !!l);
	return (
		<div className="mail-reader-labels" aria-label="Labels">
			{rowLabels.map((l) => (
				<LabelChip key={l.id} label={l}>
					<button type="button" aria-label={`Remove label ${l.name}`} onClick={() => onRemoveLabel(l.id)}>
						<XIcon size={10} weight="bold" />
					</button>
				</LabelChip>
			))}
			<button type="button" className="mail-button" data-label-anchor aria-expanded={pickerOpen} onClick={onLabel}>
				<TagIcon size={13} /> {rowLabels.length ? "Labels" : "Add label"}
			</button>
		</div>
	);
}

export default function UnifiedReader({
	open, autoOpened = false, state, onRemoved, onBack, composeFrom, setComposeFrom, addresses, idle, row, labels, onLabel, onRemoveLabel, pickerOpen,
}: {
	open: OpenRef | null;
	/** Opened by the wide layout rather than the user; shown without marking it read. */
	autoOpened?: boolean;
	state?: string;
	row?: Conversation;
	labels: ReadonlyMap<string, Label>;
	onLabel: () => void;
	onRemoveLabel: (labelId: string) => void;
	pickerOpen: boolean;
	onRemoved: () => void;
	onBack: () => void;
	composeFrom: string;
	setComposeFrom: (address: string) => void;
	addresses: string[];
	idle: React.ReactNode;
}) {
	const { isComposing, composeOptions, closeCompose } = useUIStore();
	const { data: email } = useEmail(open?.mailboxId, open?.emailId) as { data?: Email };
	const markThreadRead = useMarkThreadRead();
	const updateEmail = useUpdateEmail();
	const replyRef = useRef<HTMLDivElement>(null);
	const marked = useRef<string | null>(null);

	// Opening a conversation marks it read, once per open. An auto-opened one waits for the user.
	useEffect(() => {
		if (!open || autoOpened || !email || email.id !== open.emailId || marked.current === email.id) return;
		marked.current = email.id;
		if (email.read) return;
		if (email.thread_id) markThreadRead.mutate({ mailboxId: open.mailboxId, threadId: email.thread_id });
		else updateEmail.mutate({ mailboxId: open.mailboxId, id: email.id, data: { read: true } });
	}, [open, autoOpened, email, markThreadRead, updateEmail]);

	const replying = isComposing && (composeOptions.mode === "reply" || composeOptions.mode === "reply-all") && !composeOptions.draftEmail;
	useEffect(() => {
		if (replying) replyRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
	}, [replying]);

	if (isComposing && !replying) {
		const fromLocked = !!open && composeOptions.mode !== "new";
		const mailboxId = fromLocked ? open!.mailboxId : composeFrom;
		return (
			<div className="mail-reader mail-reader-compose">
				{fromLocked ? (
					<p className="mail-from"><span className="mail-caption">From</span>{mailboxId}</p>
				) : (
					<FromSelect addresses={addresses} value={composeFrom} onChange={setComposeFrom} />
				)}
				{/* Re-mount on From change so the display name and signature follow the address. */}
				<ComposePanel key={mailboxId} mailboxId={mailboxId} />
				{fromLocked && open && (
					<div className="mail-reader-quoted">
						<EmailPanel emailId={open.emailId} mailboxId={open.mailboxId} folder={folderFor(state)} onClose={() => { closeCompose(); onRemoved(); }} onBack={onBack} />
					</div>
				)}
			</div>
		);
	}

	if (!open) return <div className="mail-reader mail-reader-idle">{idle}</div>;

	return (
		<div className="mail-reader">
			{row && <ReaderLabels row={row} labels={labels} onLabel={onLabel} onRemoveLabel={onRemoveLabel} pickerOpen={pickerOpen} />}
			<div className="mail-reader-body">
				<EmailPanel emailId={open.emailId} mailboxId={open.mailboxId} folder={folderFor(state)} onClose={onRemoved} onBack={onBack} />
				{replying && (
					<div ref={replyRef} className="mail-reply-box">
						<p className="mail-from"><span className="mail-caption">From</span>{open.mailboxId}</p>
						<ComposePanel key={`reply:${open.mailboxId}`} mailboxId={open.mailboxId} />
					</div>
				)}
			</div>
		</div>
	);
}
