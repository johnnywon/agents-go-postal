import { Folders } from "../../shared/folders";
import type { Env } from "../types";
import { getMailboxStub, listMailboxes } from "./email-helpers";

export class InvalidInboxCursorError extends Error {
	constructor() {
		super("Invalid inbox cursor");
	}
}

interface InboxMessage {
	id: string;
	date: string;
	subject: string;
	sender: string;
	recipient: string;
	read: boolean;
	starred: boolean;
	snippet?: string | null;
	thread_id?: string | null;
	thread_count?: number;
	thread_unread_count?: number;
	participants?: string;
	needs_reply?: boolean;
	has_draft?: boolean;
}

interface InboxStub {
	getThreadedEmails(options: { folder: string; offset: number; limit: number }): Promise<InboxMessage[]>;
	countThreadedEmails(folder: string): Promise<number>;
}

function readOffsets(cursor: string | undefined, ids: string[]): number[] {
	if (!cursor) return ids.map(() => 0);
	if (cursor.length > 4096) throw new InvalidInboxCursorError();
	try {
		const parsed = JSON.parse(atob(cursor)) as {
			version?: number;
			ids?: unknown;
			offsets?: unknown;
		};
		if (parsed.version !== 1 || !Array.isArray(parsed.ids) || !Array.isArray(parsed.offsets)) {
			throw new InvalidInboxCursorError();
		}
		if (parsed.ids.length !== ids.length || parsed.offsets.length !== ids.length ||
			!ids.every((id, index) => parsed.ids![index] === id) ||
			!parsed.offsets.every((offset) => Number.isSafeInteger(offset) && offset >= 0 && offset <= 1_000_000)) {
			throw new InvalidInboxCursorError();
		}
		return parsed.offsets as number[];
	} catch {
		throw new InvalidInboxCursorError();
	}
}

/** Merge the next page of inbox conversations from every configured mailbox. */
export async function getCombinedInbox(env: Env, cursor?: string, pageSize = 25) {
	const configured = new Set((env.EMAIL_ADDRESSES ?? []).map((address) => address.toLowerCase()));
	const ids = (await listMailboxes(env.BUCKET))
		.map((mailbox) => mailbox.id.toLowerCase())
		.filter((id) => configured.size === 0 || configured.has(id))
		.sort();
	const offsets = readOffsets(cursor, ids);
	const limit = Math.min(Math.max(pageSize, 1), 100);

	const mailboxPages = await Promise.all(ids.map(async (mailboxId, index) => {
		const stub = getMailboxStub(env, mailboxId) as unknown as InboxStub;
		const [emails, totalCount] = await Promise.all([
			stub.getThreadedEmails({ folder: Folders.INBOX, offset: offsets[index], limit }),
			stub.countThreadedEmails(Folders.INBOX),
		]);
		return { mailboxId, emails, totalCount };
	}));

	const candidates = mailboxPages.flatMap(({ mailboxId, emails }) =>
		emails.map((email) => ({ ...email, mailboxId })),
	);
	candidates.sort((a, b) =>
		b.date.localeCompare(a.date) || a.mailboxId.localeCompare(b.mailboxId) || a.id.localeCompare(b.id),
	);
	const emails = candidates.slice(0, limit);
	const nextOffsets = [...offsets];
	for (const email of emails) nextOffsets[ids.indexOf(email.mailboxId)]++;
	const totalCount = mailboxPages.reduce((sum, page) => sum + page.totalCount, 0);
	const nextCursor = emails.length > 0 && nextOffsets.reduce((sum, offset) => sum + offset, 0) < totalCount
		? btoa(JSON.stringify({ version: 1, ids, offsets: nextOffsets }))
		: null;
	return { emails, totalCount, nextCursor };
}
