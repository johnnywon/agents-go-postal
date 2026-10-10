export const FILTER_MIN = 12; // show the filter field at this many mailboxes
export const AUTO_OPEN_MAX = 24; // up to this many, all groups default open

export type MailboxLike = { id: string; email: string };
export type DirRow = { id: string; email: string; local: string; domain: string };
export type DirGroup = { domain: string; rows: DirRow[]; open: boolean; hasActive: boolean };
export type DirModel = {
	total: number;
	shown: number;
	filtering: boolean;
	pinned: DirRow[];
	groups: DirGroup[];
	/** "pinned:<id>" if the active row is in Pinned, else "group:<id>"; null if it is not on screen. */
	currentKey: string | null;
	/** First row in DOM order while filtering, else null. Whitespace-only queries do not filter. */
	firstMatch: DirRow | null;
};

// Not lowercase, so no real (lowercased) domain can collide with it.
const OTHER = "Other";

function compare(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function splitAddress(email: string): { local: string; domain: string } {
	const address = email.trim();
	const at = address.lastIndexOf("@");
	// Both sides need at least one character; "@x.org" and "x@" stay whole.
	if (at < 1 || at === address.length - 1) return { local: address, domain: OTHER };
	return { local: address.slice(0, at), domain: address.slice(at + 1).toLowerCase() };
}

function byAddress(a: DirRow, b: DirRow): number {
	return (
		compare(a.local.toLowerCase(), b.local.toLowerCase()) ||
		compare(a.email.toLowerCase(), b.email.toLowerCase()) ||
		compare(a.id.toLowerCase(), b.id.toLowerCase())
	);
}

function byDomainThenLocal(a: DirRow, b: DirRow): number {
	return (
		compare(a.local.toLowerCase(), b.local.toLowerCase()) ||
		compare(a.domain.toLowerCase(), b.domain.toLowerCase()) ||
		compare(a.id.toLowerCase(), b.id.toLowerCase())
	);
}

export function buildDirectory(input: {
	mailboxes: MailboxLike[];
	pinned: string[];
	open: Record<string, boolean>;
	query: string;
	activeId?: string;
}): DirModel {
	// Ids compare lowercased; the first mailbox wins when two ids differ only by case.
	const byId = new Map<string, DirRow>();
	for (const mailbox of input.mailboxes) {
		if (!mailbox || typeof mailbox.id !== "string" || !mailbox.id) continue;
		const key = mailbox.id.toLowerCase();
		if (byId.has(key)) continue;
		const email = typeof mailbox.email === "string" && mailbox.email.trim() ? mailbox.email : mailbox.id;
		byId.set(key, { id: mailbox.id, email, ...splitAddress(email) });
	}

	const tokens = (input.query || "").toLowerCase().split(/\s+/).filter(Boolean);
	const filtering = tokens.length > 0;
	const visible = [...byId.values()].filter((row) => {
		if (!filtering) return true;
		const address = row.email.trim().toLowerCase();
		return tokens.every((token) => address.includes(token));
	});

	const found = input.activeId ? byId.get(input.activeId.toLowerCase()) : undefined;
	const active = found && visible.includes(found) ? found : undefined;

	const pinnedRows: DirRow[] = [];
	if (!filtering) {
		const seen = new Set<string>();
		for (const id of input.pinned || []) {
			if (typeof id !== "string") continue;
			const key = id.toLowerCase();
			const row = byId.get(key);
			if (row && !seen.has(key)) {
				seen.add(key);
				pinnedRows.push(row);
			}
		}
		pinnedRows.sort(byDomainThenLocal);
	}

	// A Map, so a domain such as "constructor" cannot read an inherited property.
	const stored = new Map<string, boolean>();
	for (const [domain, value] of Object.entries(input.open || {})) {
		if (typeof value === "boolean") stored.set(domain.toLowerCase(), value);
	}
	const total = byId.size;
	const activeDomain = found?.domain;
	const isOpen = (domain: string): boolean =>
		filtering || (stored.get(domain.toLowerCase()) ?? (total <= AUTO_OPEN_MAX ? true : domain === activeDomain));

	const grouped = new Map<string, DirRow[]>();
	for (const row of visible) {
		const rows = grouped.get(row.domain);
		if (rows) rows.push(row);
		else grouped.set(row.domain, [row]);
	}
	const groups: DirGroup[] = [...grouped]
		.map(([domain, rows]) => ({
			domain,
			rows: rows.sort(byAddress),
			open: isOpen(domain),
			hasActive: active !== undefined && rows.includes(active),
		}))
		.sort(
			(a, b) =>
				(a.domain === OTHER ? 1 : 0) - (b.domain === OTHER ? 1 : 0) || compare(a.domain.toLowerCase(), b.domain.toLowerCase()),
		);

	return {
		total,
		shown: visible.length,
		filtering,
		pinned: pinnedRows,
		groups,
		currentKey: active ? `${pinnedRows.includes(active) ? "pinned" : "group"}:${active.id}` : null,
		firstMatch: filtering ? (groups[0]?.rows[0] ?? null) : null,
	};
}
