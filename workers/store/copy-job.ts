// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The one-time copy from the Durable Objects to D1 (docs/d1-migration-plan.md,
 * Moving existing deployments). The cron advances it a slice at a time.
 *
 * copying      Each mailbox turns on change tracking, then its mail is copied
 *              page by page. Labels and saved searches come from the index.
 * catching-up  Mail changed during the copy is copied again from each
 *              mailbox's copy outbox, until a pass finds nothing.
 * ready        Every run catches up again and refreshes the parity report.
 *              The deployment can now switch to STORAGE=d1.
 * done         The first run on D1 makes one last pass (messages and
 *              scheduled sends only, since D1 is live), then stops tracking.
 *              New inbound mail is also written to the old mailbox for two
 *              weeks, in case storage has to move back.
 */
import { durableObjectInternals, usesD1 } from "./index";
import type { MailboxDO } from "../durableObject";
import type { CopyCounts, CopyMeta, CopyRow } from "../lib/copy-rows";
import type { AttachmentInput, EmailInput } from "./d1/rows";
import { d1CopyCounts, writeCopyGlobals, writeCopyRows, writeCopyScheduled, writeCopySetup, type CopyGlobals } from "./d1/copy";
import { d1Sql, type Sql } from "./sql";
import type { Env } from "../types";

export const COPY_RUN_MS = 20_000;
export const ROLLBACK_WINDOW_MS = 14 * 24 * 60 * 60_000;

export type CopyState = "copying" | "catching-up" | "ready" | "done";

export interface ParityMailbox {
	mailboxId: string;
	ok: boolean;
	source: CopyCounts;
	d1: CopyCounts;
	pending: number;
}

export interface CopyStatus {
	state: CopyState | "none";
	startedAt?: string;
	updatedAt?: string;
	finishedAt?: string | null;
	error?: string | null;
	mailboxes: { mailboxId: string; total: number; copied: number; pagesDone: boolean }[];
	parity: { ok: boolean; checkedAt: string; labels: { ok: boolean; source: string[]; d1: string[] }; mailboxes: ParityMailbox[] } | null;
}

type Stub = DurableObjectStub<MailboxDO>;

interface Options {
	now?: () => number;
	runMs?: number;
	pageSize?: number;
}

function jobSql(env: Env): Sql {
	if (!env.DB) throw new Error("No D1 database is bound as DB");
	return d1Sql(env.DB);
}

export async function copyStatus(env: Env): Promise<CopyStatus> {
	const sql = jobSql(env);
	const [jobs, mailboxes] = await sql.batch([
		{ sql: `SELECT * FROM copy_job WHERE id = 1` },
		{ sql: `SELECT mailbox_id, total, copied, pages_done FROM copy_mailboxes ORDER BY mailbox_id` },
	]);
	const job = jobs[0];
	const list = mailboxes.map((m) => ({ mailboxId: String(m.mailbox_id), total: Number(m.total), copied: Number(m.copied), pagesDone: !!m.pages_done }));
	if (!job) return { state: "none", mailboxes: list, parity: null };
	return {
		state: String(job.state) as CopyState,
		startedAt: String(job.started_at),
		updatedAt: String(job.updated_at),
		finishedAt: (job.finished_at as string | null) ?? null,
		error: (job.error as string | null) ?? null,
		mailboxes: list,
		parity: job.parity ? JSON.parse(String(job.parity)) : null,
	};
}

/** Labels and saved searches from the index. */
async function indexGlobals(env: Env): Promise<CopyGlobals> {
	return (await durableObjectInternals(env).index().copyGlobals()) as unknown as CopyGlobals;
}

/** Null when a copy can start, else why not. */
export async function copyStartError(env: Env): Promise<string | null> {
	if (!env.DB) return "Bind a D1 database as DB and apply the migrations first";
	if (usesD1(env)) return "This deployment already runs on D1. The copy reads the Durable Objects, so it runs before switching";
	const sql = jobSql(env);
	if (await sql.first(`SELECT 1 AS ok FROM copy_job WHERE id = 1`)) return "A copy has already started";
	if (await sql.first(`SELECT 1 AS ok FROM messages LIMIT 1`)) return "The D1 database already holds mail. Copy into an empty database";
	return null;
}

export async function startCopy(env: Env, now = Date.now()) {
	const at = new Date(now).toISOString();
	await jobSql(env).run(`INSERT INTO copy_job (id, state, started_at, updated_at) VALUES (1, 'copying', ?, ?)`, at, at);
}

/** One slice of the copy. Does nothing without a job, or once it is done. */
export async function advanceCopy(env: Env, options: Options = {}): Promise<CopyState | "none"> {
	const now = options.now ?? Date.now;
	const deadline = now() + (options.runMs ?? COPY_RUN_MS);
	const sql = jobSql(env);
	const job = await sql.first(`SELECT state FROM copy_job WHERE id = 1`);
	if (!job) return "none";
	let state = String(job.state) as CopyState;
	if (state === "done") return state;
	const internals = durableObjectInternals(env);
	const stamp = (fields: string, ...params: unknown[]) =>
		sql.run(`UPDATE copy_job SET ${fields}, updated_at = ? WHERE id = 1`, ...params, new Date(now()).toISOString());
	try {
		const final = state === "ready" && usesD1(env);
		const mailboxIds = (await internals.registry.list()).map((m) => m.id.toLowerCase());
		if (!final) {
			await writeCopyGlobals(sql, await indexGlobals(env), { prune: true });
			// Copy every page of every mailbox, including one added since the copy started.
			for (const mailboxId of mailboxIds) {
				if (!(await copyPages(env, sql, mailboxId, deadline, now, options.pageSize))) {
					if (state !== "copying") await stamp("state = 'copying'");
					return "copying";
				}
			}
			if (state === "copying") await stamp("state = ?", (state = "catching-up"));
		}
		for (const mailboxId of mailboxIds) {
			if (!(await catchUp(env, sql, mailboxId, deadline, now, { final, pageSize: options.pageSize }))) return state;
		}
		const parity = await checkParity(env, sql, mailboxIds);
		if (final) {
			for (const mailboxId of mailboxIds) await internals.mailbox(mailboxId).copyStop();
			await stamp("state = 'done', finished_at = ?, error = NULL, parity = ?", new Date(now()).toISOString(), JSON.stringify(parity));
			return "done";
		}
		await stamp("state = 'ready', error = NULL, parity = ?", JSON.stringify(parity));
		return "ready";
	} catch (e) {
		await stamp("error = ?", ((e as Error).message || "Copy failed").slice(0, 1000)).catch(() => {});
		throw e;
	}
}

/**
 * Write rows, first adding any label they carry that D1 doesn't have yet: a
 * label made after this run's label copy, on mail whose mailbox wasn't
 * tracking changes yet. Adds only; deleted labels go at the next run's start.
 */
async function writeRows(env: Env, sql: Sql, mailboxId: string, rows: CopyRow[], missing: string[] = []) {
	const wanted = [...new Set(rows.flatMap((r) => r.labels))];
	if (wanted.length > 0) {
		const have = new Set((await sql.all(`SELECT id FROM labels WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify(wanted))).map((r) => String(r.id)));
		if (wanted.some((id) => !have.has(id))) {
			await writeCopyGlobals(sql, await indexGlobals(env), { prune: false });
		}
	}
	await writeCopyRows(sql, env.BUCKET, mailboxId, rows, missing);
}

/** Copy pages until the mailbox is done (true) or time is up (false). */
async function copyPages(env: Env, sql: Sql, mailboxId: string, deadline: number, now: () => number, pageSize?: number): Promise<boolean> {
	const internals = durableObjectInternals(env);
	const stub = internals.mailbox(mailboxId);
	let row = await sql.first(`SELECT after_id, pages_done FROM copy_mailboxes WHERE mailbox_id = ?`, mailboxId);
	if (row?.pages_done) return true;
	if (!row) {
		// Tracking starts before the first page, so nothing changed after this point is missed.
		const { total } = await stub.copyStart(mailboxId);
		await writeCopySetup(sql, mailboxId, await internals.registry.get(mailboxId), (await stub.copyMeta()) as CopyMeta);
		await sql.run(`INSERT INTO copy_mailboxes (mailbox_id, total) VALUES (?, ?)`, mailboxId, total);
		row = { after_id: null, pages_done: 0 };
	}
	let afterId = (row.after_id as string | null) ?? null;
	while (now() < deadline) {
		const page = await stub.copyPage(afterId, pageSize);
		await writeRows(env, sql, mailboxId, page.rows as CopyRow[]);
		const done = page.nextAfterId === null;
		afterId = page.nextAfterId;
		await sql.run(
			`UPDATE copy_mailboxes SET after_id = ?, copied = copied + ?, pages_done = ? WHERE mailbox_id = ?`,
			afterId, page.rows.length, done ? 1 : 0, mailboxId,
		);
		if (done) return true;
	}
	return false;
}

/** Re-copy what changed since the last pass, then the settings and scheduled sends. False when time ran out. */
async function catchUp(
	env: Env, sql: Sql, mailboxId: string, deadline: number, now: () => number,
	options: { final: boolean; pageSize?: number },
): Promise<boolean> {
	const internals = durableObjectInternals(env);
	const stub = internals.mailbox(mailboxId);
	for (;;) {
		if (now() >= deadline) return false;
		const changes = await stub.copyChanges(options.pageSize);
		if (changes.ids.length === 0) break;
		await writeRows(env, sql, mailboxId, changes.rows as CopyRow[], changes.missing);
		await stub.copyAck(changes.ids, changes.seq);
	}
	const meta = (await stub.copyMeta()) as CopyMeta;
	// On the final pass D1 is live: its settings and folders are newer than the mailbox's.
	if (!options.final) await writeCopySetup(sql, mailboxId, await internals.registry.get(mailboxId), meta);
	await writeCopyScheduled(sql, mailboxId, meta, async (ids) => new Set((await stub.copyRows(ids)).rows.map((r) => r.id)));
	return true;
}

async function checkParity(env: Env, sql: Sql, mailboxIds: string[]) {
	const internals = durableObjectInternals(env);
	const d1Labels = (await sql.all(`SELECT id FROM labels ORDER BY id`)).map((r) => String(r.id));
	const sourceLabels = (await indexGlobals(env)).labels.map((l) => String(l.id)).sort();
	const labels = { ok: JSON.stringify(d1Labels) === JSON.stringify(sourceLabels), source: sourceLabels, d1: d1Labels };
	const known = new Set(d1Labels);
	const mailboxes: ParityMailbox[] = [];
	for (const mailboxId of mailboxIds) {
		const status = await internals.mailbox(mailboxId).copyStatus();
		const source = status.counts as CopyCounts;
		// A message label whose label was deleted from the index isn't copied.
		source.labels = Object.fromEntries(Object.entries(source.labels).filter(([id]) => known.has(id)));
		const d1 = await d1CopyCounts(sql, mailboxId);
		mailboxes.push({ mailboxId, ok: sameCounts(source, d1), source, d1, pending: status.pending });
	}
	return { ok: labels.ok && mailboxes.every((m) => m.ok), checkedAt: new Date().toISOString(), labels, mailboxes };
}

function sameCounts(a: CopyCounts, b: CopyCounts): boolean {
	const sorted = (o: Record<string, unknown>) => JSON.stringify(Object.entries(o).sort(([x], [y]) => x.localeCompare(y)));
	return sorted(a.states) === sorted(b.states) && sorted(a.labels) === sorted(b.labels)
		&& a.attachments === b.attachments && a.scheduled === b.scheduled;
}

/**
 * During the two weeks after cutover, inbound mail is also written to the
 * old mailbox so a move back to the Durable Objects loses none of it.
 */
export async function mirrorInbound(env: Env, mailboxId: string, folder: string, email: EmailInput, attachments: AttachmentInput[], now = Date.now()) {
	if (!usesD1(env)) return;
	const job = await jobSql(env).first(`SELECT finished_at FROM copy_job WHERE id = 1 AND state = 'done'`);
	if (!job?.finished_at || now - Date.parse(String(job.finished_at)) > ROLLBACK_WINDOW_MS) return;
	const stub: Stub = durableObjectInternals(env).mailbox(mailboxId);
	await stub.createEmail(folder, email, attachments);
}
