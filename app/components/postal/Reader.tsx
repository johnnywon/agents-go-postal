// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	ArchiveIcon, ArrowBendDoubleUpLeftIcon, ArrowBendUpLeftIcon, ArrowBendUpRightIcon, CaretLeftIcon, CheckIcon, CodeIcon, DownloadSimpleIcon, EnvelopeOpenIcon, EnvelopeSimpleIcon, FileIcon, ImageIcon, PaperclipIcon, PencilSimpleLineIcon, PlusIcon, SparkleIcon, StarIcon, TagIcon, TrashIcon, XIcon,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Folders } from "shared/folders";
import EmailIframe, { hasRemoteImages } from "~/components/EmailIframe";
import { getAttachmentUrl, getNonInlineAttachments, rewriteInlineImages } from "~/lib/utils";
import { useEmail, useMarkThreadRead, useThreadReplies } from "~/queries/emails";
import { useMailFacets } from "~/queries/mail";
import type { Conversation, Label } from "~/services/api";
import type { Email } from "~/types";
import type { DraftResult } from "./Agent";
import type { AddressInfo, ComposeMode, ComposeState, useMailSender } from "./compose";
import { Composer } from "./ComposeWindow";
import { AddressText, type Identities, Swatch } from "./identity";
import { formatSize, fullDate, nameFromHeaders } from "./model";
import type { Prefs } from "./prefs";

type Sender = ReturnType<typeof useMailSender>;

export interface ReaderProps {
	row?: Conversation;
	open: { mailboxId: string; emailId: string } | null;
	/** Opened by the layout, not the user: shown without marking it read. */
	autoOpened: boolean;
	identities: Identities;
	info: ReadonlyMap<string, AddressInfo>;
	addresses: string[];
	prefs: Prefs;
	labels: Label[];
	labelsById: ReadonlyMap<string, Label>;
	showAside: boolean;
	canTrash: boolean;
	onBack: () => void;
	onAction: (action: "archive" | "trash" | "read" | "star") => void;
	onLabel: (label: Label, add: boolean) => void;
	onCreateLabel: (name: string) => void;
	/** The open reply composer, keyed so a mode switch starts it afresh. */
	inline: { key: number; initial: ComposeState } | null;
	onInlineClosed: (message: string | null) => void;
	startReply: (mode: Exclude<ComposeMode, "new">, original: Email, keep?: ComposeState, askAgent?: boolean) => void;
	sender: Sender;
	onPopOut: (state: ComposeState) => void;
	onEditDraft: (draft: Email) => void;
	onEditSignatures: () => void;
	draftWithAgent: (state: ComposeState) => Promise<DraftResult>;
	replyRequest: { mode: Exclude<ComposeMode, "new">; id: number } | null;
}

function sortAsc(list: Email[]) {
	return [...list].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
}

export function Reader(props: ReaderProps) {
	const { row, open, identities } = props;
	const { data: email } = useEmail(open?.mailboxId, open?.emailId);
	const { data: thread } = useThreadReplies(open?.mailboxId, email?.thread_id);
	const markThreadRead = useMarkThreadRead();
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const [shownImages, setShownImages] = useState<Set<string>>(new Set());
	const [pickerOpen, setPickerOpen] = useState(false);
	const [pickerLeft, setPickerLeft] = useState(8);
	const labelBtn = useRef<HTMLButtonElement>(null);
	const sectionRef = useRef<HTMLElement>(null);
	const openPicker = () => {
		const b = labelBtn.current?.getBoundingClientRect();
		const r = sectionRef.current?.getBoundingClientRect();
		if (b && r) setPickerLeft(Math.max(8, Math.min(b.left - r.left, r.width - 268)));
		setPickerOpen((v) => !v);
	};
	const [source, setSource] = useState<Email | null>(null);
	const marked = useRef<string | null>(null);
	const scrollRef = useRef<HTMLDivElement>(null);

	const messages = useMemo(() => {
		if (!email) return [];
		const others = (thread ?? []).filter((m) => m.id !== email.id);
		return sortAsc([email, ...others]);
	}, [email, thread]);
	const latest = messages[messages.length - 1];
	const self = open?.mailboxId ?? "";
	const original = useMemo(() => {
		const received = messages.filter((m) => m.folder_id !== Folders.DRAFT && m.sender.toLowerCase() !== self);
		return received[received.length - 1] ?? messages.filter((m) => m.folder_id !== Folders.DRAFT).pop() ?? latest;
	}, [messages, self, latest]);
	const draft = messages.find((m) => m.folder_id === Folders.DRAFT);

	// Opening marks the conversation read, once, unless the setting is off or the layout opened it.
	useEffect(() => {
		if (!open || props.autoOpened || !props.prefs.markRead || !email || email.id !== open.emailId || marked.current === email.id) return;
		marked.current = email.id;
		if (row && !row.unread) return;
		if (email.thread_id) markThreadRead.mutate({ mailboxId: open.mailboxId, threadId: email.thread_id });
		else if (!email.read) props.onAction("read");
	}, [open, props.autoOpened, props.prefs.markRead, email, row]); // eslint-disable-line react-hooks/exhaustive-deps

	useEffect(() => {
		setExpanded(new Set());
		setPickerOpen(false);
		scrollRef.current?.scrollTo({ top: 0 });
	}, [open?.mailboxId, open?.emailId]);

	// r / a / f from the keyboard.
	useEffect(() => {
		if (props.replyRequest && original) props.startReply(props.replyRequest.mode, original);
	}, [props.replyRequest]); // eslint-disable-line react-hooks/exhaustive-deps

	if (!open) {
		return (
			<section className="pg-reader" aria-label="Message">
				<div className="pg-idle">
					<img className="deck-brand-logo" src="/brand/app-icon.svg" alt="" width={64} height={64} />
					<p>Pick a conversation.</p>
				</div>
			</section>
		);
	}

	const sent = row?.state === "sent";
	const mailbox = open.mailboxId;
	const identity = identities.of(mailbox);
	const head = latest ?? email;
	const senderName = head ? (sent ? head.recipient : nameFromHeaders(head.raw_headers, row?.sender_name || head.sender)) : row?.sender_name ?? "";
	const senderAddr = head ? (sent ? "" : head.sender) : row?.sender_addr ?? "";
	const rowLabels = (row?.labels ?? []).map((id) => props.labelsById.get(id)).filter((l): l is Label => !!l);
	const starred = row?.starred ?? !!email?.starred;
	const unread = row?.unread ?? false;
	const reply = (mode: Exclude<ComposeMode, "new">) => original && props.startReply(mode, original);

	return (
		<section className="pg-reader" aria-label="Message" ref={sectionRef}>
			{pickerOpen && row && (
				<LabelPicker
					left={pickerLeft}
					labels={props.labels}
					active={new Set(row.labels)}
					onToggle={(l, add) => props.onLabel(l, add)}
					onCreate={props.onCreateLabel}
					onClose={() => setPickerOpen(false)}
				/>
			)}
			<div className="pg-reader-bar" role="toolbar" aria-label="Message actions">
				<div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0 }}>
					<button type="button" className="pg-icon-btn pg-back" onClick={props.onBack} aria-label="Back to list"><CaretLeftIcon size={16} weight="bold" /></button>
					<div className="pg-group">
						<button type="button" className="pg-icon-btn" title="Reply (R)" aria-label="Reply" onClick={() => reply("reply")} disabled={!original}><ArrowBendUpLeftIcon size={16} /></button>
						<button type="button" className="pg-icon-btn" title="Reply all (A)" aria-label="Reply all" onClick={() => reply("reply-all")} disabled={!original}><ArrowBendDoubleUpLeftIcon size={16} /></button>
						<button type="button" className="pg-icon-btn" title="Forward (F)" aria-label="Forward" onClick={() => reply("forward")} disabled={!original}><ArrowBendUpRightIcon size={16} /></button>
					</div>
					<div className="pg-group">
						<button type="button" className="pg-icon-btn" title="Archive (E) · Out of the inbox, kept in Archive" aria-label="Archive" onClick={() => props.onAction("archive")} disabled={!row}><ArchiveIcon size={16} /></button>
						<button type="button" className="pg-icon-btn" title="Move to trash · Recoverable from Trash" aria-label="Move to trash" onClick={() => props.onAction("trash")} disabled={!row || !props.canTrash}><TrashIcon size={16} /></button>
					</div>
					<div className="pg-group" style={{ position: "relative" }}>
						<button type="button" className="pg-icon-btn" title={unread ? "Mark read" : "Mark unread"} aria-label={unread ? "Mark read" : "Mark unread"} onClick={() => props.onAction("read")} disabled={!row}>
							{unread ? <EnvelopeOpenIcon size={16} /> : <EnvelopeSimpleIcon size={16} />}
						</button>
						<button type="button" className="pg-icon-btn" title={starred ? "Unstar" : "Star"} aria-label={starred ? "Unstar" : "Star"} aria-pressed={starred} onClick={() => props.onAction("star")} disabled={!row}>
							<StarIcon size={16} weight={starred ? "fill" : "regular"} color={starred ? "var(--pg-amber)" : undefined} />
						</button>
						<button ref={labelBtn} type="button" className="pg-icon-btn" title="Label · Labels are shared by every address" aria-label="Label" aria-expanded={pickerOpen} onClick={openPicker} disabled={!row}><TagIcon size={16} /></button>
					</div>
					<div style={{ flex: 1 }} />
					<button type="button" className="pg-icon-btn" title="View source · The raw message with all headers" aria-label="View source" onClick={() => head && setSource(head)} disabled={!head}><CodeIcon size={16} /></button>
				</div>
			</div>
			<div className="pg-reader-scroll" ref={scrollRef}>
				<div className="pg-reader-main">
					<div className="pg-reader-meta">
						<span className="pg-reader-to" title={`Delivered to ${mailbox} — replies send from here`}>
							<Swatch identity={identity} />
							<AddressText address={mailbox} identity={identity} />
						</span>
						<span style={{ flex: "none", whiteSpace: "nowrap" }}>{head ? fullDate(head.date) : row ? fullDate(row.date) : ""}</span>
					</div>
					<h1 className="pg-subject">{row?.subject || email?.subject || "(no subject)"}</h1>
					<div className="pg-reader-from">
						{sent && <span className="pg-to-word">To</span>}
						<span className="pg-name">{senderName}</span>
						{senderAddr && senderAddr !== senderName && <span className="pg-email">{senderAddr}</span>}
					</div>
					{/* TODO(roadmap): per-email agent card (what the agent did, its steps and one-click actions) returns with rules. */}
					<div className="pg-reader-content">
						{!email && <div className="pg-skel" style={{ border: 0, padding: 0 }}><span className="pg-pulse" style={{ width: "80%" }} /></div>}
						{messages.length > 1 && (
							<div className="pg-earlier">
								{messages.slice(0, -1).filter((m) => !expanded.has(m.id)).map((m) => (
									<button key={m.id} type="button" onClick={() => setExpanded((s) => new Set(s).add(m.id))}>
										<span className="pg-who">{m.folder_id === Folders.DRAFT ? "Draft" : nameFromHeaders(m.raw_headers, m.sender)}</span>
										<span className="pg-flex pg-ellipsis">{(m.snippet || "").slice(0, 140)}</span>
										<span className="pg-when">{fullDate(m.date)}</span>
									</button>
								))}
							</div>
						)}
						{messages.map((m, i) => {
							const last = i === messages.length - 1;
							if (!last && !expanded.has(m.id)) return null;
							return (
								<Message
									key={m.id}
									email={m}
									mailboxId={mailbox}
									showHead={messages.length > 1}
									images={props.prefs.images === "always" || shownImages.has(m.id)}
									onShowImages={() => setShownImages((s) => new Set(s).add(m.id))}
								/>
							);
						})}
					</div>
					{draft && !props.inline ? (
						<button type="button" className="pg-reply-bar" onClick={() => props.onEditDraft(draft)}>
							<PencilSimpleLineIcon size={16} style={{ flex: "none" }} />
							<span className="pg-flex pg-ellipsis">Edit draft</span>
						</button>
					) : props.inline ? (
						<Composer
							key={props.inline.key}
							variant="inline"
							initial={props.inline.initial}
							addresses={props.addresses}
							identities={identities}
							info={props.info}
							sender={props.sender}
							lockFrom={props.prefs.replyFrom}
							onClosed={props.onInlineClosed}
							onPopOut={props.onPopOut}
							onMode={(mode, keep) => original && props.startReply(mode, original, keep)}
							draftWithAgent={props.draftWithAgent}
							onEditSignatures={props.onEditSignatures}
						/>
					) : (
						original && (
							<div className="pg-reply-bar" role="button" tabIndex={0} onClick={() => reply("reply")} onKeyDown={(e) => e.key === "Enter" && reply("reply")}>
								<ArrowBendUpLeftIcon size={16} style={{ flex: "none" }} />
								<span className="pg-flex pg-ellipsis">Reply to {nameFromHeaders(original.raw_headers, original.sender)}</span>
								<button
									type="button"
									className="pg-btn pg-btn-agent"
									title="Let the agent write a first draft"
									onClick={(e) => {
										e.stopPropagation();
										props.startReply("reply", original, undefined, true);
									}}
								>
									<SparkleIcon size={13} weight="fill" />Draft with agent
								</button>
							</div>
						)
					)}
				</div>
				{props.showAside && (
					<Aside
						mailbox={mailbox}
						identities={identities}
						labels={rowLabels}
						attachments={email ? getNonInlineAttachments(messages.flatMap((m) => m.attachments ?? [])) : []}
						attachmentOwner={(id) => messages.find((m) => m.attachments?.some((a) => a.id === id))?.id ?? email?.id ?? ""}
						sender={sent ? "" : senderAddr}
						onAddLabel={openPicker}
					/>
				)}
			</div>
			{source && <SourceModal email={source} onClose={() => setSource(null)} />}
		</section>
	);
}

function Message({ email, mailboxId, showHead, images, onShowImages }: {
	email: Email;
	mailboxId: string;
	showHead: boolean;
	images: boolean;
	onShowImages: () => void;
}) {
	const body = rewriteInlineImages(email.body || "", mailboxId, email.id, email.attachments);
	const remote = hasRemoteImages(body);
	const attachments = getNonInlineAttachments(email.attachments);
	return (
		<>
			{showHead && (
				<div className="pg-message-head">
					<b>{email.folder_id === Folders.DRAFT ? "Draft" : nameFromHeaders(email.raw_headers, email.sender)}</b>
					<span className="pg-mono">{email.sender}</span>
					<span className="pg-mono" style={{ marginLeft: "auto" }}>{fullDate(email.date)}</span>
				</div>
			)}
			{remote && !images && (
				<div className="pg-images-note">
					<ImageIcon size={14} />
					<span className="pg-flex">Images are hidden so the sender can’t see when you open this.</span>
					<button type="button" className="pg-btn" onClick={onShowImages}>Show images</button>
				</div>
			)}
			<div className="pg-mail-frame">
				<EmailIframe autoSize body={body} remoteImages={images} padding={24} />
			</div>
			{attachments.length > 0 && (
				<div className="pg-attachments">
					{attachments.map((a) => (
						<a key={a.id} className="pg-attach" href={getAttachmentUrl(mailboxId, email.id, a.id)} download={a.filename} target="_blank" rel="noopener noreferrer">
							<FileIcon size={16} color="var(--pg-text-5)" />
							<span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
								<span className="pg-attach-name">{a.filename}</span>
								<span className="pg-attach-meta">{(a.mimetype.split("/")[1] || a.mimetype).toUpperCase()} · {formatSize(a.size)}</span>
							</span>
							<DownloadSimpleIcon size={14} color="var(--pg-text-6)" />
						</a>
					))}
				</div>
			)}
		</>
	);
}

function Aside({ mailbox, identities, labels, attachments, attachmentOwner, sender, onAddLabel }: {
	mailbox: string;
	identities: Identities;
	labels: Label[];
	attachments: { id: string; filename: string; mimetype: string; size: number }[];
	attachmentOwner: (attachmentId: string) => string;
	sender: string;
	onAddLabel: () => void;
}) {
	const identity = identities.of(mailbox);
	const facets = useMailFacets({ view: "all", chips: sender ? [{ kind: "from", value: sender }] : [], sort: "date", dir: "desc" }, !!sender);
	const history = (facets.data?.address ?? []).slice(0, 5);
	return (
		<aside className="pg-aside" aria-label="Details">
			<section>
				<span className="pg-caption">DELIVERED TO</span>
				<span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
					<Swatch identity={identity} />
					<AddressText address={mailbox} identity={identity} />
				</span>
				<span className="pg-hint">Replies send from this address</span>
			</section>
			<section>
				<span className="pg-caption">LABELS</span>
				<div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
					{labels.map((l) => <span key={l.id} className="pg-label-chip" style={{ height: 20 }}><TagIcon size={10} />{l.name}</span>)}
					<button type="button" className="pg-label-add" onClick={onAddLabel}>+ add</button>
				</div>
			</section>
			{attachments.length > 0 && (
				<section>
					<span className="pg-caption">ATTACHMENTS</span>
					{attachments.map((a) => (
						<a key={a.id} className="pg-attach" style={{ maxWidth: "none" }} href={getAttachmentUrl(mailbox, attachmentOwner(a.id), a.id)} download={a.filename} target="_blank" rel="noopener noreferrer">
							<PaperclipIcon size={16} color="var(--pg-text-5)" />
							<span style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
								<span className="pg-attach-name">{a.filename}</span>
								<span className="pg-attach-meta">{(a.mimetype.split("/")[1] || a.mimetype).toUpperCase()} · {formatSize(a.size)}</span>
							</span>
							<DownloadSimpleIcon size={14} color="var(--pg-text-6)" />
						</a>
					))}
				</section>
			)}
			{sender && (
				<section>
					<span className="pg-caption">SENDER ACROSS YOUR ADDRESSES</span>
					<span className="pg-mono" style={{ fontSize: 12, color: "var(--pg-text-4)" }}>{sender.slice(sender.lastIndexOf("@") + 1)}</span>
					{history.map((h) => {
						const id = identities.of(h.value);
						return (
							<div key={h.value} className="pg-history">
								<Swatch identity={id} />
								<span className="pg-flex pg-ellipsis">{h.value}</span>
								<span style={{ color: "var(--pg-text-6)" }}>{h.count}</span>
							</div>
						);
					})}
				</section>
			)}
		</aside>
	);
}

export function LabelPicker({ left, labels, active, onToggle, onCreate, onClose }: {
	left: number;
	labels: Label[];
	active: ReadonlySet<string>;
	onToggle: (label: Label, add: boolean) => void;
	onCreate: (name: string) => void;
	onClose: () => void;
}) {
	const [query, setQuery] = useState("");
	const q = query.trim().toLowerCase();
	const shown = labels.filter((l) => l.name.toLowerCase().includes(q));
	const exact = labels.some((l) => l.name.toLowerCase() === q);
	return (
		<>
			<div className="pg-scrim-click" onClick={onClose} />
			<div className="pg-popover pg-label-picker" style={{ top: 42, left }} role="dialog" aria-label="Labels" data-mail-popover>
				<input
					autoFocus
					value={query}
					placeholder="Label or new label"
					aria-label="Find or create a label"
					onChange={(e) => setQuery(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Escape") {
							e.stopPropagation();
							onClose();
						} else if (e.key === "Enter" && q) {
							e.preventDefault();
							if (shown[0] && !active.has(shown[0].id)) onToggle(shown[0], true);
							else if (!exact) onCreate(query.trim());
							setQuery("");
						}
					}}
				/>
				<div className="pg-list-scroll">
					{shown.map((l) => {
						const on = active.has(l.id);
						return (
							<button key={l.id} type="button" role="menuitemcheckbox" aria-checked={on} className="pg-menu-item" onClick={() => onToggle(l, !on)}>
								<span className="pg-check pg-check-neutral" data-on={on}>{on && <CheckIcon size={10} weight="bold" />}</span>
								<TagIcon size={14} color="var(--pg-text-6)" />
								<span className="pg-flex pg-ellipsis">{l.name}</span>
							</button>
						);
					})}
					{q && !exact && (
						<button type="button" className="pg-menu-item" onClick={() => { onCreate(query.trim()); setQuery(""); }}>
							<PlusIcon size={14} />
							<span className="pg-flex pg-ellipsis">Create “{query.trim()}”</span>
						</button>
					)}
				</div>
			</div>
		</>
	);
}

function SourceModal({ email, onClose }: { email: Email; onClose: () => void }) {
	let headers = "";
	try {
		const parsed = JSON.parse(email.raw_headers || "[]") as unknown;
		const list = Array.isArray(parsed)
			? (parsed as { key?: string; value?: unknown }[]).map((h) => [h.key, h.value] as const)
			: Object.entries(parsed as Record<string, unknown>);
		headers = list.map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join("\n");
	} catch {
		headers = email.raw_headers || "";
	}
	return (
		<div className="pg-modal-scrim" onClick={onClose} onKeyDown={(e) => e.key === "Escape" && onClose()}>
			<div className="pg-modal is-source" role="dialog" aria-modal="true" aria-label="Message source" onClick={(e) => e.stopPropagation()}>
				<div className="pg-modal-head">
					<span className="pg-modal-icon"><CodeIcon size={16} /></span>
					<div className="pg-modal-title"><h2>Source</h2><span>{email.message_id || email.id}</span></div>
					<button type="button" className="pg-modal-x" title="Close (Esc)" aria-label="Close" onClick={onClose} autoFocus><XIcon size={16} /></button>
				</div>
				<pre className="pg-source">{`${headers}\n\n${email.body || ""}`}</pre>
			</div>
		</div>
	);
}
