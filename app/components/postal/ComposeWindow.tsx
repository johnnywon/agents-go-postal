// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	ArrowSquareOutIcon, ArrowsInSimpleIcon, ArrowsOutSimpleIcon, CalendarBlankIcon, CaretDownIcon, CaretUpIcon, CheckIcon, ClockIcon,
	FileIcon, FloppyDiskIcon, MinusIcon, PaperclipIcon, PaperPlaneRightIcon, PencilSimpleLineIcon, SparkleIcon, TrashIcon, WarningIcon, XIcon,
} from "@phosphor-icons/react";
import type { Editor as TipTap } from "@tiptap/react";
import { useEffect, useRef, useState } from "react";
import { type AddressInfo, type ComposeState, isValidAddress, parseRecipient, readFiles, type Recipient, textToParagraphs, type useMailSender } from "./compose";
import { Editor, FormatBar } from "./Editor";
import { AddressText, type Identities, Swatch } from "./identity";
import { formatSize, sendTimeLabel } from "./model";
import type { DraftResult } from "./Agent";

type Sender = ReturnType<typeof useMailSender>;
type Field = "to" | "cc" | "bcc";

export interface ComposeWindowProps {
	initial: ComposeState;
	/** Opened maximised, as in a popped-out window. */
	maximised?: boolean;
	addresses: string[];
	identities: Identities;
	info: ReadonlyMap<string, AddressInfo>;
	sender: Sender;
	onClosed: (message: string | null) => void;
	onPopOut: (state: ComposeState) => void;
	draftWithAgent: (state: ComposeState) => Promise<DraftResult>;
}

/** Recipient chips: Enter, Tab, comma or space adds; Backspace removes; invalid addresses get an amber outline. */
export function RecipientField({ label, list, onChange, inputRef, autoFocus, extra }: {
	label: string;
	list: Recipient[];
	onChange: (list: Recipient[]) => void;
	inputRef?: React.Ref<HTMLInputElement>;
	autoFocus?: boolean;
	extra?: React.ReactNode;
}) {
	const [text, setText] = useState("");
	const local = useRef<HTMLInputElement>(null);
	const add = (raw: string) => {
		const r = parseRecipient(raw);
		setText("");
		if (!r || list.some((x) => x.addr.toLowerCase() === r.addr.toLowerCase())) return;
		onChange([...list, r]);
	};
	// TODO(roadmap): contact autocomplete (suggestions from past correspondents) under this field.
	return (
		<div className="pg-cw-row is-wrap">
			<span className="pg-field-label">{label}</span>
			<div className="pg-chips" onClick={() => local.current?.focus()}>
				{list.map((r, i) => (
					<span key={`${r.addr}-${i}`} className="pg-chip" title={r.addr} data-invalid={!isValidAddress(r.addr) || undefined}>
						<span>{r.name || r.addr}</span>
						<button type="button" aria-label={`Remove ${r.addr}`} onMouseDown={(e) => { e.preventDefault(); onChange(list.filter((_, j) => j !== i)); }}>
							<XIcon size={10} />
						</button>
					</span>
				))}
				<input
					ref={(el) => {
						local.current = el;
						if (typeof inputRef === "function") inputRef(el);
						else if (inputRef) (inputRef as React.MutableRefObject<HTMLInputElement | null>).current = el;
					}}
					value={text}
					autoFocus={autoFocus}
					aria-label={label}
					spellCheck={false}
					autoComplete="off"
					onChange={(e) => setText(e.target.value)}
					onBlur={() => text.includes("@") && add(text)}
					onPaste={(e) => {
						const pasted = e.clipboardData.getData("text");
						if (/[,;\s]/.test(pasted.trim())) {
							e.preventDefault();
							const parts = pasted.split(/[,;\s]+/).map(parseRecipient).filter((r): r is Recipient => !!r);
							onChange([...list, ...parts.filter((p) => !list.some((x) => x.addr === p.addr))]);
						}
					}}
					onKeyDown={(e) => {
						if ((e.key === "Enter" || e.key === "Tab") && text.trim()) {
							e.preventDefault();
							add(text);
						} else if ((e.key === "," || e.key === ";" || e.key === " ") && text.includes("@")) {
							e.preventDefault();
							add(text);
						} else if (e.key === "Backspace" && !text && list.length) {
							onChange(list.slice(0, -1));
						}
					}}
				/>
			</div>
			{extra}
		</div>
	);
}

function nextDay(add: number, hour: number) {
	const d = new Date();
	d.setDate(d.getDate() + add);
	d.setHours(hour, 0, 0, 0);
	return d;
}

function nextMonday() {
	const d = new Date();
	const days = (8 - d.getDay()) % 7 || 7;
	return nextDay(days, 8);
}

const pad = (n: number) => String(n).padStart(2, "0");
const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function ComposeWindow(props: ComposeWindowProps) {
	const { identities, info, sender } = props;
	const [state, setState] = useState<ComposeState>(props.initial);
	const [mode, setMode] = useState<"normal" | "min" | "max">(props.maximised ? "max" : "normal");
	const [fromOpen, setFromOpen] = useState(false);
	const [schedOpen, setSchedOpen] = useState(false);
	const [custom, setCustom] = useState(false);
	const [customDate, setCustomDate] = useState(() => isoDay(new Date(Date.now() + 864e5)));
	const [customTime, setCustomTime] = useState("09:00");
	const [warn, setWarn] = useState<"norecip" | "nosubj" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);
	const [busy, setBusy] = useState(false);
	const [agentBusy, setAgentBusy] = useState(false);
	const [editor, setEditor] = useState<TipTap | null>(null);
	const toRef = useRef<HTMLInputElement>(null);
	const fileRef = useRef<HTMLInputElement>(null);
	const saving = useRef<Promise<void>>(Promise.resolve());
	const stateRef = useRef(state);
	stateRef.current = state;
	const dirty = useRef(false);
	const done = useRef(false);

	const patch = (p: Partial<ComposeState>, quiet = false) => {
		setState((s) => ({ ...s, ...p }));
		setWarn(null);
		setError(null);
		if (!quiet) {
			dirty.current = true;
			setSaved(false);
		}
	};

	const hasContent = (s: ComposeState) => !!(s.to.length || s.cc.length || s.bcc.length || s.subject.trim() || s.html.replace(/<[^>]+>/g, "").trim());

	const saveNow = () => {
		saving.current = saving.current.then(async () => {
			const s = stateRef.current;
			if (!hasContent(s) || done.current) return;
			dirty.current = false;
			const id = await sender.save(s);
			if (id) setState((cur) => ({ ...cur, draftId: id }));
			stateRef.current = { ...stateRef.current, draftId: id || stateRef.current.draftId };
			setSaved(true);
		}).catch(() => setSaved(false));
		return saving.current;
	};

	// Autosave a moment after typing stops.
	useEffect(() => {
		if (!dirty.current) return;
		const t = setTimeout(saveNow, 1500);
		return () => clearTimeout(t);
	}, [state]); // eslint-disable-line react-hooks/exhaustive-deps

	const finish = (message: string | null) => {
		done.current = true;
		props.onClosed(message);
	};

	// TODO(roadmap): undo send (a short hold before delivery). Sending is final for now.
	const send = async (force = false) => {
		if (busy) return;
		if (!state.to.length && !state.cc.length && !state.bcc.length) {
			setWarn("norecip");
			return;
		}
		if (!state.subject.trim() && !force) {
			setWarn("nosubj");
			return;
		}
		setBusy(true);
		try {
			await saving.current;
			done.current = true;
			await sender.send(stateRef.current);
			props.onClosed(`Message sent from ${state.from}`);
		} catch (e) {
			done.current = false;
			setError((e as Error).message || "Could not send.");
		} finally {
			setBusy(false);
		}
	};

	const schedule = async (at: Date) => {
		if (busy) return;
		if (!state.to.length && !state.cc.length && !state.bcc.length) {
			setWarn("norecip");
			setSchedOpen(false);
			return;
		}
		setBusy(true);
		try {
			await saving.current;
			done.current = true;
			await sender.schedule(stateRef.current, at);
			props.onClosed(`Scheduled for ${sendTimeLabel(at)}`);
		} catch (e) {
			done.current = false;
			setError((e as Error).message || "Could not schedule.");
		} finally {
			setBusy(false);
			setSchedOpen(false);
		}
	};

	const close = async () => {
		if (hasContent(stateRef.current) && (dirty.current || !stateRef.current.draftId)) await saveNow();
		await saving.current;
		finish(hasContent(stateRef.current) ? "Draft saved" : null);
	};

	const discard = async () => {
		done.current = true;
		await saving.current;
		await sender.discard(stateRef.current);
		finish("Draft discarded");
	};

	const askAgent = async () => {
		if (agentBusy) return;
		setAgentBusy(true);
		setError(null);
		try {
			const r = await props.draftWithAgent(stateRef.current);
			const html = r.text ? textToParagraphs(r.text) : r.html ?? "";
			if (html) patch({ html, ...(r.draftId ? { draftId: r.draftId } : {}) });
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setAgentBusy(false);
		}
	};

	const customAt = new Date(`${customDate}T${customTime}`);
	const customOk = !Number.isNaN(customAt.getTime()) && customAt.getTime() > Date.now() + 60_000;
	const fromInfo = info.get(state.from);
	const fromId = identities.of(state.from);

	return (
		<>
			{mode === "max" && <div className="pg-cw-scrim" onMouseDown={() => setMode("normal")} />}
			<div
				className="pg-cw"
				role="dialog"
				aria-label="New message"
				data-state={mode}
				onKeyDown={(e) => {
					if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
						e.preventDefault();
						send();
					} else if (e.key === "Escape") {
						e.preventDefault();
						e.stopPropagation();
						if (fromOpen || schedOpen) {
							setFromOpen(false);
							setSchedOpen(false);
						} else setMode("min");
					}
				}}
			>
				<div className="pg-cw-head" onClick={(e) => mode === "min" && !(e.target as Element).closest("button") && setMode("normal")}>
					<PencilSimpleLineIcon size={14} color="var(--pg-text-5)" />
					<span className="pg-title">{state.subject.trim() || "New message"}</span>
					<span className="pg-saved" aria-live="polite">{saved ? "Draft saved" : ""}</span>
					<button type="button" className="pg-cw-btn" title="Open in new window" aria-label="Open in new window" onMouseDown={(e) => { e.preventDefault(); done.current = true; props.onPopOut(stateRef.current); }}>
						<ArrowSquareOutIcon size={15} />
					</button>
					<button type="button" className="pg-cw-btn" title={mode === "min" ? "Restore" : "Minimize"} aria-label={mode === "min" ? "Restore" : "Minimize"} onMouseDown={(e) => { e.preventDefault(); setMode(mode === "min" ? "normal" : "min"); }}>
						{mode === "min" ? <CaretUpIcon size={15} /> : <MinusIcon size={15} />}
					</button>
					<button type="button" className="pg-cw-btn pg-desktop-only" title="Full screen" aria-label="Full screen" onMouseDown={(e) => { e.preventDefault(); setMode(mode === "max" ? "normal" : "max"); }}>
						{mode === "max" ? <ArrowsInSimpleIcon size={15} /> : <ArrowsOutSimpleIcon size={15} />}
					</button>
					<button type="button" className="pg-cw-btn" title="Save & close" aria-label="Save and close" onMouseDown={(e) => { e.preventDefault(); close(); }}>
						<XIcon size={15} />
					</button>
				</div>
				<div className="pg-cw-body">
					<div className="pg-cw-row">
						<span className="pg-field-label">From</span>
						<button type="button" className="pg-cw-from" aria-haspopup="listbox" aria-expanded={fromOpen} onClick={() => setFromOpen((v) => !v)}>
							<Swatch identity={fromId} />
							<span className="pg-name">{fromInfo?.name}</span>
							<AddressText address={state.from} identity={fromId} bold={false} />
							<CaretDownIcon size={10} color="var(--pg-text-6)" />
						</button>
						{fromOpen && (
							<>
								<div className="pg-scrim-click" style={{ zIndex: 4 }} onClick={() => setFromOpen(false)} />
								<div className="pg-popover pg-from-menu" style={{ zIndex: 5 }} role="listbox" aria-label="Send from">
									{props.addresses.map((a) => {
										const id = identities.of(a);
										return (
											<button key={a} type="button" role="option" aria-selected={a === state.from} className="pg-menu-item" data-active={a === state.from} onClick={() => { patch({ from: a }); setFromOpen(false); }}>
												<Swatch identity={id} />
												<span className="pg-flex pg-ellipsis" style={{ fontSize: 12 }}><AddressText address={a} identity={id} bold={false} /></span>
												<span className="pg-name">{info.get(a)?.name}</span>
												{a === state.from && <CheckIcon size={12} weight="bold" />}
											</button>
										);
									})}
								</div>
							</>
						)}
					</div>
					<RecipientField
						label="To"
						list={state.to}
						onChange={(to) => patch({ to })}
						inputRef={toRef}
						autoFocus={!state.to.length}
						extra={
							<div className="pg-cc-toggles">
								{!state.showCc && <button type="button" onMouseDown={(e) => { e.preventDefault(); patch({ showCc: true }, true); }}>Cc</button>}
								{!state.showBcc && <button type="button" onMouseDown={(e) => { e.preventDefault(); patch({ showBcc: true }, true); }}>Bcc</button>}
							</div>
						}
					/>
					{state.showCc && <RecipientField label="Cc" list={state.cc} onChange={(cc) => patch({ cc })} autoFocus={!state.cc.length} />}
					{state.showBcc && <RecipientField label="Bcc" list={state.bcc} onChange={(bcc) => patch({ bcc })} autoFocus={!state.bcc.length && !state.showCc} />}
					<div className="pg-cw-row">
						<span className="pg-field-label">Subject</span>
						<input className="pg-cw-subject" value={state.subject} aria-label="Subject" onChange={(e) => patch({ subject: e.target.value })} />
					</div>
					<div className="pg-cw-scroll">
						<Editor value={state.html} onChange={(html) => patch({ html })} placeholder="Write your message…" size="window" onReady={setEditor} autoFocus={state.to.length > 0} />
						<div className="pg-signature">{fromInfo?.signatureText}</div>
					</div>
					{state.files.length > 0 && (
						<div className="pg-files">
							{state.files.map((f, i) => (
								<span key={`${f.name}-${i}`} className="pg-file">
									<FileIcon size={14} color="var(--pg-text-5)" />
									<span className="pg-file-name">{f.name}</span>
									<span className="pg-file-size">{formatSize(f.size)}</span>
									<button type="button" aria-label={`Remove ${f.name}`} onClick={() => patch({ files: state.files.filter((_, j) => j !== i) })}><XIcon size={11} /></button>
								</span>
							))}
						</div>
					)}
					{warn && (
						<div className="pg-warn" role="alert">
							<WarningIcon size={14} />
							<span className="pg-flex">{warn === "norecip" ? "Add at least one recipient." : "This message has no subject."}</span>
							{warn === "nosubj" && <button type="button" className="pg-send-anyway" onClick={() => send(true)}>Send anyway</button>}
						</div>
					)}
					{error && (
						<div className="pg-error" role="alert"><WarningIcon size={14} /><span className="pg-flex">{error}</span></div>
					)}
					<FormatBar editor={editor} />
					<div className="pg-cw-foot">
						<div className="pg-send-split">
							<button type="button" className="pg-send" title="Send (⌘↵)" onClick={() => send()} disabled={busy}>
								Send<PaperPlaneRightIcon size={12} weight="bold" />
							</button>
							<button type="button" className="pg-caret" title="Schedule send" aria-label="Schedule send" aria-expanded={schedOpen} onClick={() => { setSchedOpen((v) => !v); setCustom(false); }}>
								<CaretDownIcon size={11} weight="bold" />
							</button>
							{schedOpen && (
								<>
									<div className="pg-scrim-click" style={{ zIndex: 4 }} onClick={() => setSchedOpen(false)} />
									<div className="pg-popover pg-sched" style={{ zIndex: 5 }} role="menu" aria-label="Schedule send">
										<span className="pg-caption">SCHEDULE SEND</span>
										{([["Tomorrow morning", nextDay(1, 8)], ["Tomorrow afternoon", nextDay(1, 13)], ["Monday morning", nextMonday()]] as const).map(([label, at]) => (
											<button key={label} type="button" role="menuitem" className="pg-menu-item" onClick={() => schedule(at)}>
												<ClockIcon size={14} color="var(--pg-text-6)" />
												<span className="pg-flex">{label}</span>
												<span className="pg-when">{sendTimeLabel(at)}</span>
											</button>
										))}
										<hr />
										{!custom ? (
											<button type="button" role="menuitem" className="pg-menu-item" onClick={() => setCustom(true)}>
												<CalendarBlankIcon size={14} color="var(--pg-text-6)" />
												<span className="pg-flex">Pick date &amp; time…</span>
											</button>
										) : (
											<div className="pg-sched-custom">
												<span className="pg-small">Send at</span>
												<div className="pg-inputs">
													<input type="date" aria-label="Date" value={customDate} min={isoDay(new Date())} onChange={(e) => setCustomDate(e.target.value)} />
													<input type="time" aria-label="Time" value={customTime} onChange={(e) => setCustomTime(e.target.value)} />
												</div>
												<div className="pg-times">
													{([["8:00", "08:00"], ["9:00", "09:00"], ["13:00", "13:00"], ["17:00", "17:00"]] as const).map(([label, v]) => (
														<button key={v} type="button" onClick={() => setCustomTime(v)}>{label}</button>
													))}
												</div>
												<span className="pg-note" data-bad={!customOk || undefined}>{customOk ? `Sends ${sendTimeLabel(customAt)} · your time zone` : "Pick a time in the future"}</span>
												<button type="button" className="pg-btn pg-btn-primary" disabled={!customOk || busy} onClick={() => customOk && schedule(customAt)}>
													<ClockIcon size={12} weight="bold" />Schedule send
												</button>
											</div>
										)}
									</div>
								</>
							)}
						</div>
						<button type="button" className="pg-tool-btn" title="Attach files" aria-label="Attach files" onMouseDown={(e) => { e.preventDefault(); fileRef.current?.click(); }}>
							<PaperclipIcon size={15} />
						</button>
						<input
							ref={fileRef}
							type="file"
							multiple
							hidden
							onChange={async (e) => {
								const list = e.target.files;
								if (list?.length) {
									const files = await readFiles(list);
									patch({ files: [...stateRef.current.files, ...files] });
								}
								e.target.value = "";
							}}
						/>
						<button type="button" className="pg-btn pg-btn-agent" data-busy={agentBusy} title="Draft with agent" onMouseDown={(e) => { e.preventDefault(); askAgent(); }}>
							<SparkleIcon size={13} weight="fill" /><span className="pg-agent-label">{agentBusy ? "Drafting…" : "Draft with agent"}</span>
						</button>
						<div className="pg-flex" />
						<button type="button" className="pg-btn pg-btn-outline" title="Save as draft" onMouseDown={(e) => { e.preventDefault(); saveNow().then(() => finish("Draft saved")); }}>
							<FloppyDiskIcon size={14} /><span className="pg-save-label">Save draft</span>
						</button>
						<button type="button" className="pg-tool-btn" title="Discard draft" aria-label="Discard draft" onMouseDown={(e) => { e.preventDefault(); discard(); }}>
							<TrashIcon size={15} />
						</button>
					</div>
				</div>
			</div>
		</>
	);
}
