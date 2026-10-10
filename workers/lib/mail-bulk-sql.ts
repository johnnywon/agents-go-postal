// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Index-side planning for bulk actions, undo and label definitions. The
 * index decides which messages change and records their prior state; the
 * mailbox DOs apply the ops. Pure functions over `Exec`.
 */

import { DEFAULT_LABEL_COLOR, isLabelColor } from "../../shared/label-colors";
import { type MailFilter, filterWhere } from "./mail-index-sql";
import type { Exec } from "./sql-exec";

export const MAX_OP_IDS = 100;
export const UNDO_TTL_MS = 60 * 60 * 1000;
export const MOVE_FOLDERS = ["inbox", "archive", "spam", "trash"] as const;

export type BulkAction =
	| { type: "archive" | "trash" | "restore" | "read" | "unread" | "star" | "unstar" }
	| { type: "move"; folder: (typeof MOVE_FOLDERS)[number] }
	| { type: "label_add" | "label_remove"; labelId: string };

export type BulkOp =
	| { mailboxId: string; kind: "move"; emailIds: string[]; to: string; from: string }
	| { mailboxId: string; kind: "flags"; emailIds: string[]; patch: { read?: boolean; starred?: boolean } }
	| { mailboxId: string; kind: "labels"; emailIds: string[]; add: string[]; remove: string[] }
	| { mailboxId: string; kind: "purge"; emailIds: string[] };

/** What a bulk job runs: a user bulk action, or Empty Trash. */
export type JobAction = BulkAction | { type: "empty_trash" };

/** Prior state of one changed row: enough to reverse exactly that change. */
export interface UndoEntry {
	mailbox_id: string;
	email_id: string;
	/** Moves: the state before, and the state the action moved it to. */
	state?: string;
	to?: string;
	unread?: boolean;
	starred?: boolean;
	label?: { id: string; had: boolean };
}

export interface UndoPayload {
	action: BulkAction;
	entries: UndoEntry[];
}

export class BulkConflictError extends Error {
	override name = "BulkConflictError";
	constructor(readonly count: number) {
		super(`The list changed: ${count} conversations match now`);
	}
}

const MOVE_TARGET: Partial<Record<BulkAction["type"], string>> = { archive: "archive", trash: "trash", restore: "inbox" };

/**
 * The state a thread move takes messages from. Unread, Starred and All mail
 * act on the Inbox part of a thread; Sent and Drafts only when they are the view.
 */
export function sourceState(view: string): string {
	if (view === "drafts") return "draft";
	if (view === "unread" || view === "starred" || view === "all") return "inbox";
	return view;
}

/** Mailbox folder id for an index state. */
export function stateToFolder(state: string): string {
	return state.startsWith("folder:") ? state.slice(7) : state;
}

function moveTarget(action: BulkAction): string | null {
	if (action.type === "move") return action.folder;
	return MOVE_TARGET[action.type] ?? null;
}

/**
 * Conversations a filter matches, counting only messages dated at or before
 * `asOf` so mail that arrived after the user looked is left alone. Throws
 * BulkConflictError when the count differs from what the user saw.
 */
export function resolveFilterTarget(
	exec: Exec,
	filter: MailFilter,
	asOf: string,
	expectedCount: number,
	now = Date.now(),
): string[] {
	const w = filterWhere(filter, now);
	const keys = exec(
		`SELECT DISTINCT m.thread_key AS k FROM messages m WHERE ${w.sql} AND m.date <= ?`,
		...w.params,
		asOf,
	).map((r) => String(r.k));
	if (keys.length !== expectedCount) throw new BulkConflictError(keys.length);
	return keys;
}

interface PlanRow {
	id: number;
	mailbox_id: string;
	email_id: string;
	thread_key: string;
	state: string;
	date: string;
	unread: boolean;
	starred: boolean;
	has_label: boolean;
}

function groupOps<T extends BulkOp>(make: (mailboxId: string, ids: string[], key: string) => T, rows: { mailbox_id: string; email_id: string; key: string }[]): T[] {
	const groups = new Map<string, { mailboxId: string; key: string; ids: string[] }>();
	for (const row of rows) {
		const k = `${row.mailbox_id}\u0000${row.key}`;
		const group = groups.get(k) ?? { mailboxId: row.mailbox_id, key: row.key, ids: [] };
		group.ids.push(row.email_id);
		groups.set(k, group);
	}
	const ops: T[] = [];
	for (const group of groups.values()) {
		for (let i = 0; i < group.ids.length; i += MAX_OP_IDS) {
			ops.push(make(group.mailboxId, group.ids.slice(i, i + MAX_OP_IDS), group.key));
		}
	}
	return ops;
}

/** Ops that apply an action to these threads, and the undo entries that reverse them. */
export function planBulk(
	exec: Exec,
	threadKeys: string[],
	view: string,
	action: BulkAction,
): { ops: BulkOp[]; entries: UndoEntry[] } {
	if (threadKeys.length === 0) return { ops: [], entries: [] };
	const labelId = action.type === "label_add" || action.type === "label_remove" ? action.labelId : "";
	const rows: PlanRow[] = exec(
		`SELECT m.id, m.mailbox_id, m.email_id, m.thread_key, m.state, m.date, m.unread, m.starred,
			EXISTS (SELECT 1 FROM message_labels l WHERE l.message = m.id AND l.label_id = ?) AS has_label
		FROM messages m
		WHERE m.deleted = 0 AND m.thread_key IN (SELECT value FROM json_each(?))
		ORDER BY m.thread_key, m.date DESC, m.id DESC`,
		labelId,
		JSON.stringify([...new Set(threadKeys)]),
	).map((r) => ({
		id: Number(r.id),
		mailbox_id: String(r.mailbox_id),
		email_id: String(r.email_id),
		thread_key: String(r.thread_key),
		state: String(r.state),
		date: String(r.date),
		unread: !!r.unread,
		starred: !!r.starred,
		has_label: !!r.has_label,
	}));

	const target = moveTarget(action);
	if (target !== null) {
		const from = sourceState(view);
		if (from === target) return { ops: [], entries: [] };
		const chosen = rows.filter((r) => r.state === from);
		const entries = chosen.map((r) => ({ mailbox_id: r.mailbox_id, email_id: r.email_id, state: r.state, to: target }));
		const ops = groupOps(
			(mailboxId, emailIds) => ({ mailboxId, kind: "move" as const, emailIds, to: target, from: stateToFolder(from) }),
			chosen.map((r) => ({ ...r, key: "" })),
		);
		return { ops, entries };
	}

	let chosen: PlanRow[];
	switch (action.type) {
		case "read": chosen = rows.filter((r) => r.unread); break;
		case "unread": chosen = rows.filter((r) => !r.unread); break;
		case "star": {
			const latest = new Map<string, PlanRow>();
			for (const r of rows) if (r.state !== "draft" && !latest.has(r.thread_key)) latest.set(r.thread_key, r);
			chosen = [...latest.values()].filter((r) => !r.starred);
			break;
		}
		case "unstar": chosen = rows.filter((r) => r.starred); break;
		case "label_add": chosen = rows.filter((r) => !r.has_label); break;
		case "label_remove": chosen = rows.filter((r) => r.has_label); break;
		default: chosen = [];
	}

	const keyed = chosen.map((r) => ({ ...r, key: "" }));
	if (action.type === "label_add" || action.type === "label_remove") {
		const add = action.type === "label_add";
		return {
			ops: groupOps((mailboxId, emailIds) => ({
				mailboxId, kind: "labels" as const, emailIds, add: add ? [action.labelId] : [], remove: add ? [] : [action.labelId],
			}), keyed),
			entries: chosen.map((r) => ({ mailbox_id: r.mailbox_id, email_id: r.email_id, label: { id: action.labelId, had: r.has_label } })),
		};
	}
	const patch = action.type === "read" ? { read: true }
		: action.type === "unread" ? { read: false }
		: action.type === "star" ? { starred: true }
		: { starred: false };
	const flagEntry = (r: PlanRow): UndoEntry => "read" in patch
		? { mailbox_id: r.mailbox_id, email_id: r.email_id, unread: r.unread }
		: { mailbox_id: r.mailbox_id, email_id: r.email_id, starred: r.starred };
	return {
		ops: groupOps((mailboxId, emailIds) => ({ mailboxId, kind: "flags" as const, emailIds, patch }), keyed),
		entries: chosen.map(flagEntry),
	};
}

/** Ops that put every recorded row back the way it was before the action. */
export function planUndo(payload: UndoPayload): BulkOp[] {
	const ops: BulkOp[] = [];
	const rows = payload.entries;
	ops.push(...groupOps((mailboxId, emailIds, key) => {
		const [to, from] = key.split("\u0000");
		return { mailboxId, kind: "move" as const, emailIds, to, from };
	}, rows.filter((e) => e.state !== undefined && e.to !== undefined)
		.map((e) => ({ ...e, key: `${stateToFolder(e.state!)}\u0000${stateToFolder(e.to!)}` }))));
	ops.push(...groupOps((mailboxId, emailIds, key) => ({ mailboxId, kind: "flags" as const, emailIds, patch: { read: key === "read" } }),
		rows.filter((e) => e.unread !== undefined).map((e) => ({ ...e, key: e.unread ? "unread" : "read" }))));
	ops.push(...groupOps((mailboxId, emailIds, key) => ({ mailboxId, kind: "flags" as const, emailIds, patch: { starred: key === "starred" } }),
		rows.filter((e) => e.starred !== undefined).map((e) => ({ ...e, key: e.starred ? "starred" : "plain" }))));
	ops.push(...groupOps((mailboxId, emailIds, key) => {
		const [had, id] = [key.slice(0, 1), key.slice(1)];
		return { mailboxId, kind: "labels" as const, emailIds, add: had === "1" ? [id] : [], remove: had === "1" ? [] : [id] };
	}, rows.filter((e) => e.label).map((e) => ({ ...e, key: `${e.label!.had ? "1" : "0"}${e.label!.id}` }))));
	return ops;
}

// ── Empty Trash ────────────────────────────────────────────────────

/** Messages and conversations in Trash across every mailbox. */
export function trashCount(exec: Exec): { messages: number; conversations: number } {
	const row = exec(`SELECT COUNT(*) AS m, COUNT(DISTINCT thread_key) AS c FROM messages WHERE state = 'trash' AND deleted = 0`)[0];
	return { messages: Number(row.m), conversations: Number(row.c) };
}

/**
 * Purge ops for every message in Trash. Throws BulkConflictError when the
 * count differs from the one the user confirmed.
 */
export function planEmptyTrash(exec: Exec, expectedCount: number): BulkOp[] {
	const rows = exec(`SELECT mailbox_id, email_id FROM messages WHERE state = 'trash' AND deleted = 0 ORDER BY mailbox_id, email_id`)
		.map((r) => ({ mailbox_id: String(r.mailbox_id), email_id: String(r.email_id), key: "" }));
	if (rows.length !== expectedCount) throw new BulkConflictError(rows.length);
	return groupOps((mailboxId, emailIds) => ({ mailboxId, kind: "purge" as const, emailIds }), rows);
}

export function opSize(ops: BulkOp[]): number {
	return ops.reduce((n, op) => n + op.emailIds.length, 0);
}

// ── Undo records ───────────────────────────────────────────────────

export function pruneUndo(exec: Exec, now = Date.now()): void {
	exec(`DELETE FROM undo WHERE created_at < ?`, new Date(now - UNDO_TTL_MS).toISOString());
}

export function saveUndo(exec: Exec, id: string, payload: UndoPayload, now = Date.now()): void {
	pruneUndo(exec, now);
	exec(`INSERT INTO undo (id, created_at, payload) VALUES (?, ?, ?)`, id, new Date(now).toISOString(), JSON.stringify(payload));
}

/** The undo record, once. Missing or older than an hour returns null. */
export function takeUndo(exec: Exec, id: string, now = Date.now()): UndoPayload | null {
	pruneUndo(exec, now);
	const row = exec(`DELETE FROM undo WHERE id = ? RETURNING payload`, id)[0];
	return row ? (JSON.parse(String(row.payload)) as UndoPayload) : null;
}

// ── Bulk jobs (over 500 messages) ──────────────────────────────────

export interface BulkJob {
	id: string;
	action: JobAction;
	total: number;
	done: number;
	affected: number;
	failed: { mailboxId: string; error: string }[];
	undoId: string;
	finishedAt: string | null;
}

export function createBulkJob(exec: Exec, id: string, action: JobAction, ops: BulkOp[], undoId: string, now = Date.now()): void {
	exec(
		`INSERT INTO bulk_job (id, created_at, action, ops, total, undo_id) VALUES (?, ?, ?, ?, ?, ?)`,
		id, new Date(now).toISOString(), JSON.stringify(action), JSON.stringify(ops), ops.length, undoId,
	);
}

/** The oldest unfinished job and its next ops. */
export function nextBulkOps(exec: Exec, limit: number): { id: string; position: number; ops: BulkOp[] } | null {
	const row = exec(`SELECT id, ops, position FROM bulk_job WHERE finished_at IS NULL ORDER BY created_at LIMIT 1`)[0];
	if (!row) return null;
	const position = Number(row.position);
	return { id: String(row.id), position, ops: (JSON.parse(String(row.ops)) as BulkOp[]).slice(position, position + limit) };
}

export function saveBulkProgress(
	exec: Exec,
	id: string,
	step: { ops: number; affected: number; failed: { mailboxId: string; error: string }[] },
	now = Date.now(),
): void {
	const row = exec(`SELECT position, total, failed FROM bulk_job WHERE id = ?`, id)[0];
	if (!row) return;
	const position = Number(row.position) + step.ops;
	const failed = [...(JSON.parse(String(row.failed)) as unknown[]), ...step.failed];
	exec(
		`UPDATE bulk_job SET position = ?, affected = affected + ?, failed = ?, finished_at = ? WHERE id = ?`,
		position, step.affected, JSON.stringify(failed), position >= Number(row.total) ? new Date(now).toISOString() : null, id,
	);
}

export function getBulkJob(exec: Exec, id: string): BulkJob | null {
	const row = exec(`SELECT * FROM bulk_job WHERE id = ?`, id)[0];
	if (!row) return null;
	return {
		id: String(row.id),
		action: JSON.parse(String(row.action)),
		total: Number(row.total),
		done: Number(row.position),
		affected: Number(row.affected),
		failed: JSON.parse(String(row.failed)),
		undoId: String(row.undo_id),
		finishedAt: (row.finished_at as string | null) ?? null,
	};
}

/** Finished jobs older than the undo window are dropped. */
export function pruneBulkJobs(exec: Exec, now = Date.now()): void {
	exec(`DELETE FROM bulk_job WHERE finished_at IS NOT NULL AND finished_at < ?`, new Date(now - UNDO_TTL_MS).toISOString());
}

// ── Labels ─────────────────────────────────────────────────────────

export interface Label {
	id: string;
	name: string;
	color: string;
	position: number;
}

export class LabelError extends Error {
	override name = "LabelError";
}

const MAX_LABEL_NAME = 60;

export function labelSlug(name: string, taken: Set<string>): string {
	const base = name.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
		.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "label";
	if (!taken.has(base)) return base;
	for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

function cleanName(name: unknown): string {
	const value = typeof name === "string" ? name.replace(/\s+/g, " ").trim() : "";
	if (!value) throw new LabelError("Label name is required");
	if (value.length > MAX_LABEL_NAME) throw new LabelError(`Label name is longer than ${MAX_LABEL_NAME} characters`);
	return value;
}

function cleanColor(color: unknown): string {
	if (color === undefined || color === null || color === "") return DEFAULT_LABEL_COLOR;
	if (typeof color !== "string" || !isLabelColor(color)) throw new LabelError("Pick a colour from the palette");
	return color.toLowerCase();
}

export function allLabels(exec: Exec): Label[] {
	return exec(`SELECT id, name, color, position FROM labels ORDER BY position, name COLLATE NOCASE`).map((r) => ({
		id: String(r.id), name: String(r.name), color: String(r.color), position: Number(r.position),
	}));
}

/** Labels with the number of conversations that carry each, outside Trash and Spam. */
export function listLabels(exec: Exec): (Label & { count: number })[] {
	const counts = new Map(exec(
		`SELECT l.label_id AS id, COUNT(DISTINCT m.thread_key) AS n FROM message_labels l
		JOIN messages m ON m.id = l.message WHERE m.deleted = 0 AND m.state NOT IN ('trash', 'spam')
		GROUP BY l.label_id`,
	).map((r) => [String(r.id), Number(r.n)]));
	return allLabels(exec).map((label) => ({ ...label, count: counts.get(label.id) ?? 0 }));
}

export function findLabelByName(exec: Exec, name: string): Label | null {
	return allLabels(exec).find((l) => l.name.toLowerCase() === name.trim().toLowerCase()) ?? null;
}

export function createLabel(exec: Exec, input: { name: unknown; color?: unknown; id?: string }): Label {
	const name = cleanName(input.name);
	const color = cleanColor(input.color);
	const existing = allLabels(exec);
	if (existing.some((l) => l.name.toLowerCase() === name.toLowerCase())) throw new LabelError(`A label named "${name}" exists`);
	const taken = new Set(existing.map((l) => l.id));
	const id = input.id && !taken.has(input.id) ? input.id : labelSlug(name, taken);
	const position = existing.reduce((max, l) => Math.max(max, l.position + 1), 0);
	exec(`INSERT INTO labels (id, name, color, position) VALUES (?, ?, ?, ?)`, id, name, color, position);
	return { id, name, color, position };
}

export function updateLabel(exec: Exec, id: string, input: { name?: unknown; color?: unknown }): Label | null {
	const current = allLabels(exec).find((l) => l.id === id);
	if (!current) return null;
	const name = input.name === undefined ? current.name : cleanName(input.name);
	const color = input.color === undefined ? current.color : cleanColor(input.color);
	if (allLabels(exec).some((l) => l.id !== id && l.name.toLowerCase() === name.toLowerCase())) {
		throw new LabelError(`A label named "${name}" exists`);
	}
	exec(`UPDATE labels SET name = ?, color = ? WHERE id = ?`, name, color, id);
	return { ...current, name, color };
}

/** Thread keys holding a label in any state, for removing it before the definition goes. */
export function labelThreadKeys(exec: Exec, id: string): string[] {
	return exec(
		`SELECT DISTINCT m.thread_key AS k FROM message_labels l JOIN messages m ON m.id = l.message
		WHERE l.label_id = ? AND m.deleted = 0`,
		id,
	).map((r) => String(r.k));
}

export function deleteLabelRows(exec: Exec, id: string): boolean {
	exec(`DELETE FROM message_labels WHERE label_id = ?`, id);
	return exec(`DELETE FROM labels WHERE id = ? RETURNING id`, id).length > 0;
}

/** Load definitions from a backup. Existing labels keep their current values. */
export function restoreLabels(exec: Exec, labels: unknown): number {
	if (!Array.isArray(labels)) return 0;
	let restored = 0;
	for (const raw of labels) {
		const l = raw as Partial<Label>;
		if (typeof l?.id !== "string" || typeof l.name !== "string") continue;
		const inserted = exec(
			`INSERT OR IGNORE INTO labels (id, name, color, position) VALUES (?, ?, ?, ?) RETURNING id`,
			l.id, l.name, typeof l.color === "string" ? l.color : DEFAULT_LABEL_COLOR, Number(l.position ?? 0),
		);
		restored += inserted.length;
	}
	return restored;
}

export function threadKeyOf(exec: Exec, mailboxId: string, emailId: string): string | null {
	const row = exec(`SELECT thread_key FROM messages WHERE mailbox_id = ? AND email_id = ? AND deleted = 0`, mailboxId.toLowerCase(), emailId)[0];
	return row ? String(row.thread_key) : null;
}
