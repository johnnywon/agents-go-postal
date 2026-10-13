// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Drafting playbooks, per address: when to use one, what to do, and an
 * example reply. Auto-draft lists them in its prompt, picks one or none, and
 * the draft's notes record which. People write playbooks in Settings > Agent;
 * nothing from incoming mail reaches them.
 */
import { z } from "zod";
import type { Sql } from "../store/sql";

export const MAX_PLAYBOOKS = 20;

export interface Playbook {
	id: string;
	name: string;
	whenToUse: string;
	instructions: string;
	exampleReply: string;
	position: number;
}

export const PlaybookBody = z.object({
	name: z.string().trim().min(1, "Give the playbook a name").max(80),
	whenToUse: z.string().max(1000).optional(),
	instructions: z.string().max(4000).optional(),
	exampleReply: z.string().max(4000).optional(),
	position: z.number().int().min(0).max(10_000).optional(),
});
export type PlaybookInput = z.infer<typeof PlaybookBody>;

const toPlaybook = (r: Record<string, unknown>): Playbook => ({
	id: String(r.id),
	name: String(r.name),
	whenToUse: String(r.when_to_use ?? ""),
	instructions: String(r.instructions ?? ""),
	exampleReply: String(r.example_reply ?? ""),
	position: Number(r.position ?? 0),
});

const COLUMNS = "id, name, when_to_use, instructions, example_reply, position";

export async function listPlaybooks(sql: Sql, mailboxId: string): Promise<Playbook[]> {
	return (await sql.all(
		`SELECT ${COLUMNS} FROM playbooks WHERE mailbox_id = ? ORDER BY position, name`,
		mailboxId.toLowerCase(),
	)).map(toPlaybook);
}

const isDuplicate = (e: unknown) => /UNIQUE/i.test((e as Error).message ?? "");

export async function createPlaybook(sql: Sql, mailboxId: string, input: PlaybookInput): Promise<{ playbook: Playbook } | { error: string }> {
	const id = mailboxId.toLowerCase();
	const now = new Date().toISOString();
	try {
		const rows = await sql.all(
			`INSERT INTO playbooks (id, mailbox_id, name, when_to_use, instructions, example_reply, position, created_at, updated_at)
			SELECT ?1, ?2, ?3, ?4, ?5, ?6, COALESCE(?7, (SELECT COALESCE(MAX(position) + 1, 0) FROM playbooks WHERE mailbox_id = ?2)), ?8, ?8
			WHERE (SELECT COUNT(*) FROM playbooks WHERE mailbox_id = ?2) < ?9
			RETURNING ${COLUMNS}`,
			crypto.randomUUID(), id, input.name.trim(), input.whenToUse ?? "", input.instructions ?? "", input.exampleReply ?? "",
			input.position ?? null, now, MAX_PLAYBOOKS,
		);
		return rows.length ? { playbook: toPlaybook(rows[0]) } : { error: `An address can have up to ${MAX_PLAYBOOKS} playbooks` };
	} catch (e) {
		if (isDuplicate(e)) return { error: "A playbook with that name exists" };
		throw e;
	}
}

export async function updatePlaybook(sql: Sql, mailboxId: string, playbookId: string, input: Partial<PlaybookInput>): Promise<{ playbook: Playbook | null } | { error: string }> {
	try {
		const rows = await sql.all(
			`UPDATE playbooks SET name = COALESCE(?, name), when_to_use = COALESCE(?, when_to_use), instructions = COALESCE(?, instructions),
				example_reply = COALESCE(?, example_reply), position = COALESCE(?, position), updated_at = ?
			WHERE mailbox_id = ? AND id = ? RETURNING ${COLUMNS}`,
			input.name?.trim() ?? null, input.whenToUse ?? null, input.instructions ?? null, input.exampleReply ?? null,
			input.position ?? null, new Date().toISOString(), mailboxId.toLowerCase(), playbookId,
		);
		return { playbook: rows.length ? toPlaybook(rows[0]) : null };
	} catch (e) {
		if (isDuplicate(e)) return { error: "A playbook with that name exists" };
		throw e;
	}
}

export async function deletePlaybook(sql: Sql, mailboxId: string, playbookId: string): Promise<boolean> {
	return (await sql.run(`DELETE FROM playbooks WHERE mailbox_id = ? AND id = ?`, mailboxId.toLowerCase(), playbookId)).changes > 0;
}

/** The playbook with this name, ignoring case, or null. */
export function findPlaybook(playbooks: readonly Playbook[], name: string | null | undefined): Playbook | null {
	const wanted = (name ?? "").trim().toLowerCase();
	if (!wanted) return null;
	return playbooks.find((p) => p.name.toLowerCase() === wanted) ?? null;
}

/** The prompt section that lists the playbooks. Empty when there are none. */
export function playbookPrompt(playbooks: readonly Playbook[]): string {
	if (playbooks.length === 0) return "";
	const list = playbooks.map((p) => {
		const lines = [`### ${p.name}`];
		if (p.whenToUse.trim()) lines.push(`When to use: ${p.whenToUse.trim()}`);
		if (p.instructions.trim()) lines.push(`Instructions: ${p.instructions.trim()}`);
		if (p.exampleReply.trim()) lines.push(`Example reply:\n${p.exampleReply.trim()}`);
		return lines.join("\n");
	}).join("\n\n");
	return `## Playbooks
The operator wrote these playbooks for this address. Pick the one whose "When to use" fits the new email and follow it, or use none if none fits. Pass its name as draft_reply's playbook, or leave playbook out.

${list}`;
}
