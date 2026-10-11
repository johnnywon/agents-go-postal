// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * URL state for the unified mail view. The URL is the single source of
 * truth: a view, an ordered list of filter chips (the drill path), a sort,
 * and the open conversation. Chips keep the order they were added in.
 */

export const VIEWS = ["inbox", "unread", "starred", "drafts", "sent", "archive", "spam", "trash", "all"] as const;
export const IS_VALUES = ["unread", "read", "starred"] as const;
export const HAS_VALUES = ["attachment", "unsubscribe"] as const;
export const DATE_TOKENS = ["today", "yesterday", "7d", "30d", "older"] as const;
export const SORTS = ["date", "from", "subject"] as const;

export type ChipKind = "address" | "from" | "label" | "is" | "has" | "subject" | "date" | "before" | "after" | "q";
export interface Chip {
	kind: ChipKind;
	value: string;
}

export interface MailFilter {
	view: string;
	chips: Chip[];
	sort: (typeof SORTS)[number];
	dir: "asc" | "desc";
}

export interface OpenRef {
	mailboxId: string;
	emailId: string;
}

export const VIEW_LABELS: Record<string, string> = {
	inbox: "Inbox", unread: "Unread", starred: "Starred", drafts: "Drafts", sent: "Sent",
	archive: "Archive", spam: "Spam", trash: "Trash", all: "All mail",
};

const CHIP_KINDS: readonly ChipKind[] = ["address", "from", "label", "is", "has", "subject", "date", "before", "after", "q"];
/** Kinds that hold one value; a later chip of the same kind replaces the earlier one. */
const SINGLE: ReadonlySet<ChipKind> = new Set(["date", "before", "after", "q"]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Keys that make a URL an explicit filter. Without any, `/` lands on unread Inbox. */
const FILTER_KEYS = new Set<string>(["view", "sort", "dir", ...CHIP_KINDS]);

export const DEFAULT_FILTER: MailFilter = { view: "inbox", chips: [{ kind: "is", value: "unread" }], sort: "date", dir: "desc" };

export function isView(value: string): boolean {
	return (VIEWS as readonly string[]).includes(value) || /^folder:[\w-]+$/.test(value);
}

function validChip(chip: Chip): Chip | null {
	const value = chip.value.trim();
	if (!value || value.length > 200) return null;
	switch (chip.kind) {
		case "is": return (IS_VALUES as readonly string[]).includes(value) ? { kind: "is", value } : null;
		case "has": return (HAS_VALUES as readonly string[]).includes(value) ? { kind: "has", value } : null;
		case "date": return (DATE_TOKENS as readonly string[]).includes(value) ? { kind: "date", value } : null;
		case "before": case "after": return ISO_DATE.test(value) ? { kind: chip.kind, value } : null;
		case "address": case "from": return { kind: chip.kind, value: value.toLowerCase() };
		default: return { kind: chip.kind, value };
	}
}

const READ_PAIR = new Set(["read", "unread"]);

/**
 * Add a chip. An equal chip, a chip of a single-value kind, or the other half
 * of read/unread is replaced in place, so the drill path keeps its order.
 */
export function addChip(chips: Chip[], raw: Chip): Chip[] {
	const chip = validChip(raw);
	if (!chip) return chips;
	const replaces = (c: Chip) =>
		c.kind === chip.kind &&
		(c.value === chip.value || SINGLE.has(chip.kind) || (chip.kind === "is" && READ_PAIR.has(c.value) && READ_PAIR.has(chip.value)));
	const out: Chip[] = [];
	let placed = false;
	for (const c of chips) {
		if (!replaces(c)) out.push(c);
		else if (!placed) {
			out.push(chip);
			placed = true;
		}
	}
	if (!placed) out.push(chip);
	return out;
}

export function removeChip(chips: Chip[], chip: Chip): Chip[] {
	return chips.filter((c) => !(c.kind === chip.kind && c.value === chip.value));
}

export function parseFilter(params: URLSearchParams): MailFilter {
	if (![...params.keys()].some((key) => FILTER_KEYS.has(key))) {
		return { ...DEFAULT_FILTER, chips: [...DEFAULT_FILTER.chips] };
	}
	const view = params.get("view") ?? "inbox";
	let chips: Chip[] = [];
	for (const [key, value] of params) {
		if ((CHIP_KINDS as readonly string[]).includes(key)) chips = addChip(chips, { kind: key as ChipKind, value });
	}
	const sort = params.get("sort") ?? "date";
	return {
		view: isView(view) ? view : "inbox",
		chips,
		sort: (SORTS as readonly string[]).includes(sort) ? (sort as MailFilter["sort"]) : "date",
		dir: params.get("dir") === "asc" ? "asc" : "desc",
	};
}

/** URL params for the filter, chips in path order. The default sort is omitted. */
export function filterToParams(filter: MailFilter): URLSearchParams {
	const params = new URLSearchParams();
	params.set("view", filter.view);
	for (const chip of filter.chips) params.append(chip.kind, chip.value);
	if (filter.sort !== "date") params.set("sort", filter.sort);
	if (filter.dir !== "desc") params.set("dir", filter.dir);
	return params;
}

export function parseOpen(params: URLSearchParams): OpenRef | null {
	const raw = params.get("open");
	if (!raw) return null;
	const at = raw.lastIndexOf(":");
	if (at <= 0 || at === raw.length - 1) return null;
	return { mailboxId: raw.slice(0, at).toLowerCase(), emailId: raw.slice(at + 1) };
}

export function openParam(ref: OpenRef): string {
	return `${ref.mailboxId}:${ref.emailId}`;
}

/** Full URL search for a filter plus the open conversation. */
export function toSearch(filter: MailFilter, open?: OpenRef | null): string {
	const params = filterToParams(filter);
	if (open) params.set("open", openParam(open));
	return `?${params}`;
}

/** Query for /api/v1/mail and /mail/facets. */
export function apiParams(filter: MailFilter, tzOffset = new Date().getTimezoneOffset()): URLSearchParams {
	const params = new URLSearchParams();
	params.set("view", filter.view);
	for (const kind of CHIP_KINDS) {
		for (const chip of filter.chips) if (chip.kind === kind) params.append(kind, chip.value);
	}
	if (filter.sort !== "date") params.set("sort", filter.sort);
	if (filter.dir !== "desc") params.set("dir", filter.dir);
	params.set("tz", String(tzOffset));
	return params;
}

export interface LabelRef {
	id: string;
	name: string;
}

const OPERATOR_RE = /(^|\s)(from|to|subject|in|is|has|before|after|label):(?:"([^"]*)"|(\S+))/gi;
const IN_VIEWS: Record<string, string> = { draft: "drafts", drafts: "drafts", inbox: "inbox", sent: "sent", archive: "archive", spam: "spam", trash: "trash", all: "all", starred: "starred", unread: "unread" };

function resolveLabel(value: string, labels: readonly LabelRef[]): string | null {
	const v = value.trim().toLowerCase();
	return labels.find((l) => l.id === v || l.name.toLowerCase() === v)?.id ?? null;
}

/**
 * Turn search text into chips. Known operators become chips; `in:` changes the
 * view; `label:` takes a label name or id; everything else, including unknown
 * operators and unknown labels, stays free text.
 */
export function parseSearchText(input: string, labels: readonly LabelRef[] = []): { view?: string; chips: Chip[]; text: string } {
	let chips: Chip[] = [];
	let view: string | undefined;
	const text = input.replace(OPERATOR_RE, (whole, lead: string, op: string, quoted?: string, bare?: string) => {
		const value = (quoted ?? bare ?? "").trim();
		const kind = op.toLowerCase();
		let chip: Chip | null = null;
		if (kind === "to") chip = { kind: "address", value };
		else if (kind === "label") {
			const id = resolveLabel(value, labels);
			if (!id) return whole;
			chip = { kind: "label", value: id };
		} else if (kind === "in") {
			const mapped = IN_VIEWS[value.toLowerCase()];
			if (!mapped) return whole;
			view = mapped;
			return lead;
		} else if (kind === "before" || kind === "after") {
			const date = value.slice(0, 10);
			if (!ISO_DATE.test(date)) return whole;
			chip = { kind, value: date };
		} else chip = { kind: kind as ChipKind, value: kind === "is" || kind === "has" ? value.toLowerCase() : value };
		const valid = validChip(chip);
		if (!valid) return whole;
		chips = addChip(chips, valid);
		return lead;
	});
	return { view, chips, text: text.replace(/\s+/g, " ").trim() };
}

/** Apply search-field input to a filter: operators become chips, the rest replaces the text chip. */
export function applySearch(filter: MailFilter, input: string, labels: readonly LabelRef[] = []): MailFilter {
	const parsed = parseSearchText(input, labels);
	let chips = filter.chips;
	for (const chip of parsed.chips) chips = addChip(chips, chip);
	if (parsed.text) chips = addChip(chips, { kind: "q", value: parsed.text });
	return { ...filter, view: parsed.view ?? filter.view, chips };
}

/** Values of one chip kind, in path order. */
export function chipValues(filter: MailFilter, kind: ChipKind): string[] {
	return filter.chips.filter((c) => c.kind === kind).map((c) => c.value);
}

// ── Legacy redirects ───────────────────────────────────────────────

const FOLDER_VIEWS: Record<string, string> = { inbox: "inbox", sent: "sent", draft: "drafts", archive: "archive", trash: "trash", spam: "spam" };

/**
 * Map an old per-mailbox `/mailbox/...` URL to the mail view, or null if it
 * is not one. A custom folder converted to a label (same id) opens that label in
 * All mail.
 */
export function legacyRedirect(pathname: string, search: string, labelIds: ReadonlySet<string> = new Set()): string | null {
	const match = pathname.match(/^\/mailbox\/([^/]+)(?:\/(emails)\/([^/]+)|\/(search|settings))?\/?$/);
	if (!match) return null;
	const mailboxId = decodeURIComponent(match[1]).toLowerCase();
	const old = new URLSearchParams(search);
	if (match[4] === "settings") return `/?address=${encodeURIComponent(mailboxId)}`;
	const params = new URLSearchParams();
	const folder = match[2] ? decodeURIComponent(match[3]) : null;
	const asLabel = folder !== null && !FOLDER_VIEWS[folder] && labelIds.has(folder);
	if (folder !== null) params.set("view", FOLDER_VIEWS[folder] ?? (asLabel ? "all" : `folder:${folder}`));
	params.append("address", mailboxId);
	if (asLabel) params.append("label", folder);
	if (match[4] === "search") {
		const q = old.get("q")?.trim();
		if (q) {
			const filter = applySearch({ view: params.get("view") ?? "inbox", chips: [{ kind: "address", value: mailboxId }], sort: "date", dir: "desc" }, q);
			return `/${toSearch(filter)}`;
		}
	}
	const email = old.get("email");
	if (email) params.set("open", `${mailboxId}:${email}`);
	if (old.get("compose") === "new") params.set("compose", "new");
	return `/?${params}`;
}

// ── Client-side matching ───────────────────────────────────────────

export interface MatchableRow {
	mailbox_id: string;
	state: string;
	sender_addr: string;
	unread: boolean;
	starred: boolean;
	has_attachment: boolean;
	can_unsubscribe: boolean;
	labels: string[];
	date: string;
}

function viewMatches(view: string, row: MatchableRow): boolean {
	switch (view) {
		case "inbox": return row.state === "inbox";
		case "unread": return row.state === "inbox" && row.unread;
		case "starred": return row.starred && row.state !== "trash" && row.state !== "spam";
		case "drafts": return row.state === "draft";
		case "all": return row.state !== "trash" && row.state !== "spam";
		default: return row.state === view;
	}
}

function addressMatches(value: string, mailboxId: string): boolean {
	const [local, domain] = mailboxId.split("@");
	const v = value.replace(/^@/, "");
	if (value.includes("@") && !value.startsWith("@")) return mailboxId === value;
	return v.includes(".") ? domain === v : local === v;
}

/**
 * Whether a row still matches a filter, for optimistic updates. Free text,
 * subject and date chips need the server and are treated as matching.
 */
export function matchesFilter(row: MatchableRow, filter: MailFilter): boolean {
	if (!viewMatches(filter.view, row)) return false;
	const addresses = chipValues(filter, "address");
	if (addresses.length && !addresses.some((a) => addressMatches(a, row.mailbox_id))) return false;
	const froms = chipValues(filter, "from");
	if (froms.length && !froms.some((f) => (f.includes("@") ? row.sender_addr === f : row.sender_addr.endsWith(`@${f.replace(/^@/, "")}`)))) return false;
	for (const label of chipValues(filter, "label")) if (!row.labels.includes(label)) return false;
	for (const value of chipValues(filter, "is")) {
		if (value === "unread" && !row.unread) return false;
		if (value === "read" && row.unread) return false;
		if (value === "starred" && !row.starred) return false;
	}
	for (const value of chipValues(filter, "has")) {
		if (value === "attachment" && !row.has_attachment) return false;
		if (value === "unsubscribe" && !row.can_unsubscribe) return false;
	}
	return true;
}
