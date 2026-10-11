// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { getReplyAddresses } from "~/lib/reply";
import { buildQuotedReplyBlock, escapeHtml, getSignatureBlock, htmlToPlainText, splitEmailList, stripHtml } from "~/lib/utils";
import { queryKeys } from "~/queries/keys";
import api from "~/services/api";
import type { Email, Mailbox } from "~/types";
import { handleOf } from "./identity";
import { ADDRESS_RE, fullDate } from "./model";

export type ComposeMode = "new" | "reply" | "reply-all" | "forward";

export interface Recipient {
	addr: string;
	name?: string;
}

export interface ComposeFile {
	name: string;
	size: number;
	type: string;
	/** base64 */
	content: string;
}

export interface ComposeState {
	mode: ComposeMode;
	from: string;
	to: Recipient[];
	cc: Recipient[];
	bcc: Recipient[];
	showCc: boolean;
	showBcc: boolean;
	subject: string;
	/** What the user writes. */
	html: string;
	files: ComposeFile[];
	/** Server draft this compose replaces when saved or sent. */
	draftId?: string;
	/** The message being replied to or forwarded. */
	originalId?: string;
	/** The address that received the original, where the agent finds it. */
	originalMailbox?: string;
	/** Quoted original, appended when sending; shown as a box in the inline composer. */
	quoteHtml?: string;
	quoteHead?: string;
	quoteText?: string;
	/** Ask the agent for a draft as soon as the composer opens. */
	askAgent?: boolean;
}

export function emptyCompose(from: string): ComposeState {
	return { mode: "new", from, to: [], cc: [], bcc: [], showCc: false, showBcc: false, subject: "", html: "", files: [] };
}

export function isValidAddress(addr: string): boolean {
	return ADDRESS_RE.test(addr.trim());
}

/** "Dana <dana@example.com>" or a bare address. */
export function parseRecipient(raw: string): Recipient | null {
	const v = raw.trim().replace(/[,;]$/, "").trim();
	if (!v) return null;
	const m = v.match(/^(.*)<(.+)>$/);
	if (m) return { addr: m[2].trim(), name: m[1].trim().replace(/^"|"$/g, "") || undefined };
	return { addr: v };
}

export function recipientsFromText(text: string): Recipient[] {
	return splitEmailList(text.replace(/;/g, ",")).map(parseRecipient).filter((r): r is Recipient => !!r);
}

export function recipientsToText(list: Recipient[]): string {
	return list.map((r) => r.addr).join(", ");
}

function prefixed(subject: string, prefix: "Re" | "Fwd") {
	const base = subject.replace(/^((re|fwd?|fw):\s*)+/i, "");
	return `${prefix}: ${base}`;
}

/** Reply, reply all or forward of a message, From set to the address it was delivered to. */
export function composeFor(mode: Exclude<ComposeMode, "new">, original: Email, mailboxId: string, from: string): ComposeState {
	const self = mailboxId.toLowerCase();
	const replyTo = getReplyAddresses(original).filter((a) => a.toLowerCase() !== self);
	let to: Recipient[] = [];
	let cc: Recipient[] = [];
	if (mode === "reply") to = (replyTo.length ? replyTo : [original.sender]).map((addr) => ({ addr }));
	if (mode === "reply-all") {
		const seen = new Set<string>([self]);
		const take = (list: string[]) =>
			list.filter((a) => {
				const k = a.toLowerCase();
				if (seen.has(k)) return false;
				seen.add(k);
				return true;
			}).map((addr) => ({ addr }));
		to = take([...replyTo, ...splitEmailList(original.recipient)]);
		cc = take(splitEmailList(original.cc));
	}
	const forward = mode === "forward";
	const when = original.date ? fullDate(original.date).replace(" · ", ", ") : "";
	const quoteHtml = forward
		? `<p><br></p><blockquote>— Forwarded message —<br>From: ${escapeHtml(original.sender)}<br>Date: ${escapeHtml(when)}<br>Subject: ${escapeHtml(original.subject)}<br><br>${escapeHtml(stripHtml(original.body || "")).replace(/\n/g, "<br>")}</blockquote>`
		: buildQuotedReplyBlock(original.date, original.sender, original.body || "");
	return {
		mode,
		from,
		to,
		cc,
		bcc: [],
		showCc: cc.length > 0 || mode === "reply-all",
		showBcc: false,
		subject: prefixed(original.subject || "", forward ? "Fwd" : "Re"),
		html: "",
		files: [],
		originalId: original.id,
		originalMailbox: self,
		quoteHtml,
		quoteHead: forward ? `— Forwarded message — ${when}, ${original.sender}` : `On ${when}, ${original.sender} wrote:`,
		quoteText: stripHtml(original.body || "").replace(/\s+/g, " ").trim(),
	};
}

/** Open a saved draft for editing. Its body already holds any quote. */
export function composeFromDraft(draft: Email, mailboxId: string): ComposeState {
	const to = recipientsFromText(draft.recipient || "");
	const cc = recipientsFromText(draft.cc || "");
	const bcc = recipientsFromText(draft.bcc || "");
	return {
		mode: draft.in_reply_to ? "reply" : "new",
		from: mailboxId,
		to,
		cc,
		bcc,
		showCc: cc.length > 0,
		showBcc: bcc.length > 0,
		subject: draft.subject || "",
		html: draft.body || "",
		files: [],
		draftId: draft.id,
		originalId: draft.in_reply_to || undefined,
		originalMailbox: mailboxId,
	};
}

// ── Address details ──────────────────────────────────────────────────

export interface AddressInfo {
	address: string;
	name: string;
	mailbox?: Mailbox;
	/** Signature shown under the editor and appended on send. */
	signatureText: string;
	signatureHtml: string;
}

/** Display names and signatures for every address, from each mailbox's settings. */
export function useAddressInfo(addresses: string[]) {
	const results = useQueries({
		queries: addresses.map((address) => ({
			queryKey: queryKeys.mailboxes.detail(address),
			queryFn: () => api.getMailbox(address),
			staleTime: 60_000,
			retry: false,
		})),
	});
	const data = results.map((r) => r.data);
	return useMemo(() => {
		const map = new Map<string, AddressInfo>();
		addresses.forEach((address, i) => {
			const mailbox = data[i];
			const name = mailbox?.settings?.fromName?.trim() || handleOf(address);
			const custom = getSignatureBlock(mailbox?.settings);
			const sig = mailbox?.settings?.signature;
			map.set(address, {
				address,
				name,
				mailbox,
				signatureText: custom ? (sig?.text || stripHtml(sig?.html || "")) : `— ${name}\n${address}`,
				signatureHtml: custom || `<p>— ${escapeHtml(name)}<br>${escapeHtml(address)}</p>`,
			});
		});
		return map;
	}, [addresses, ...data]); // eslint-disable-line react-hooks/exhaustive-deps
}

// ── Send, save, schedule ─────────────────────────────────────────────

function listValue(list: Recipient[]): string | string[] | undefined {
	const addrs = list.map((r) => r.addr.trim()).filter(Boolean);
	if (!addrs.length) return undefined;
	return addrs.length === 1 ? addrs[0] : addrs;
}

export class ComposeError extends Error {}

export function useMailSender(info: ReadonlyMap<string, AddressInfo>) {
	const queryClient = useQueryClient();

	const refresh = useCallback(
		(mailboxId: string) => {
			for (const queryKey of [["mail"], ["mail-facets"], ["emails", mailboxId], ["scheduled"]]) queryClient.invalidateQueries({ queryKey });
		},
		[queryClient],
	);

	const payload = useCallback(
		(state: ComposeState) => {
			const invalid = [...state.to, ...state.cc, ...state.bcc].find((r) => !isValidAddress(r.addr));
			if (invalid) throw new ComposeError(`Check the address ${invalid.addr}.`);
			const to = listValue(state.to);
			if (!to) throw new ComposeError("Add at least one recipient.");
			const sender = info.get(state.from);
			const name = sender?.name;
			const html = `${state.html || "<p></p>"}${sender?.signatureHtml ?? ""}${state.quoteHtml ?? ""}`;
			return {
				to,
				cc: listValue(state.cc),
				bcc: listValue(state.bcc),
				from: name && name !== state.from ? { email: state.from, name } : state.from,
				subject: state.subject,
				html,
				text: htmlToPlainText(html),
				attachments: state.files.length
					? state.files.map((f) => ({ content: f.content, filename: f.name, type: f.type || "application/octet-stream", disposition: "attachment" as const }))
					: undefined,
			};
		},
		[info],
	);

	const send = useCallback(
		async (state: ComposeState) => {
			const email = payload(state);
			const replying = (state.mode === "reply" || state.mode === "reply-all") && state.originalId;
			if (replying) await api.replyToEmail(state.from, state.originalId!, email);
			else if (state.mode === "forward" && state.originalId) await api.forwardEmail(state.from, state.originalId, email);
			else await api.sendEmail(state.from, email);
			if (state.draftId) await api.deleteEmail(state.from, state.draftId).catch(() => {});
			refresh(state.from);
		},
		[payload, refresh],
	);

	const save = useCallback(
		async (state: ComposeState): Promise<string> => {
			const result = await api.saveDraft(state.from, {
				to: recipientsToText(state.to),
				cc: recipientsToText(state.cc) || undefined,
				bcc: recipientsToText(state.bcc) || undefined,
				subject: state.subject,
				body: `${state.html}${state.quoteHtml ?? ""}`,
				in_reply_to: state.originalId,
				draft_id: state.draftId,
			});
			refresh(state.from);
			return (result as { id?: string; draft_id?: string }).id ?? (result as { draft_id?: string }).draft_id ?? "";
		},
		[refresh],
	);

	const discard = useCallback(
		async (state: ComposeState) => {
			if (!state.draftId) return;
			await api.deleteEmail(state.from, state.draftId).catch(() => {});
			refresh(state.from);
		},
		[refresh],
	);

	const schedule = useCallback(
		async (state: ComposeState, at: Date) => {
			const email = payload(state);
			await api.scheduleSend(state.from, {
				sendAt: at.toISOString(),
				draft_id: state.draftId,
				mode: state.mode,
				original_id: state.mode === "new" ? undefined : state.originalId,
				email,
			});
			refresh(state.from);
		},
		[payload, refresh],
	);

	return { send, save, discard, schedule };
}

export async function readFiles(list: FileList | File[]): Promise<ComposeFile[]> {
	const files = Array.from(list);
	return Promise.all(
		files.map(
			(file) =>
				new Promise<ComposeFile>((resolve, reject) => {
					const reader = new FileReader();
					reader.onload = () => {
						const url = String(reader.result);
						resolve({ name: file.name, size: file.size, type: file.type, content: url.slice(url.indexOf(",") + 1) });
					};
					reader.onerror = () => reject(reader.error);
					reader.readAsDataURL(file);
				}),
		),
	);
}

/** Plain text from the agent as editor paragraphs. */
export function textToParagraphs(text: string): string {
	return text
		.trim()
		.split(/\n{2,}/)
		.map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
		.join("");
}

// ── Pop-out handoff ──────────────────────────────────────────────────

export const HANDOFF_KEY = "agp-compose-handoff";

export function handOff(state: ComposeState): boolean {
	try {
		window.localStorage.setItem(HANDOFF_KEY, JSON.stringify(state));
	} catch {
		return false;
	}
	const win = window.open(`${window.location.pathname}${window.location.search}#compose`, `agp-compose-${Date.now()}`, "width=760,height=780");
	return !!win;
}

export function takeHandoff(): ComposeState | null {
	try {
		const raw = window.localStorage.getItem(HANDOFF_KEY);
		if (!raw) return null;
		window.localStorage.removeItem(HANDOFF_KEY);
		return JSON.parse(raw) as ComposeState;
	} catch {
		return null;
	}
}
