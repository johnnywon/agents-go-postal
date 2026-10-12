// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { BulkAction } from "~/lib/bulk-optimistic";
import type { Email, Mailbox } from "~/types";
import type { Prefs } from "shared/prefs";
import type { CatalogModel, KeyedProvider, ModelRef, ProviderId } from "shared/models";

const REQUEST_TIMEOUT_MS = 30_000;

export class ApiError extends Error {
	status: number;
	body: Record<string, unknown>;

	constructor(status: number, body: Record<string, unknown>) {
		super((body.error as string) || `Request failed: ${status}`);
		this.name = "ApiError";
		this.status = status;
		this.body = body;
	}
}

async function request<T>(
	url: string,
	options: RequestInit = {},
): Promise<T> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

	// Combine caller signal (e.g. TanStack Query abort) with our timeout signal
	const signal = options.signal
		? AbortSignal.any([options.signal, controller.signal])
		: controller.signal;

	try {
		const res = await fetch(url, {
			...options,
			signal,
			headers: {
				"Content-Type": "application/json",
				...(options.headers as Record<string, string>),
			},
		});

		if (!res.ok) {
			const body = await res.json().catch(() => ({}));
			throw new ApiError(res.status, body as Record<string, unknown>);
		}

		if (res.status === 204) return undefined as T;

		const contentType = res.headers.get("content-type") ?? "";
		if (contentType.includes("application/json")) {
			return res.json() as Promise<T>;
		}
		return res.blob() as unknown as T;
	} finally {
		clearTimeout(timeout);
	}
}

function get<T>(url: string, opts?: { params?: Record<string, string>; responseType?: string; signal?: AbortSignal }) {
	const query = opts?.params ? `?${new URLSearchParams(opts.params)}` : "";
	return request<T>(`${url}${query}`, {
		method: "GET",
		signal: opts?.signal,
		...(opts?.responseType === "blob" ? { headers: { Accept: "*/*" } } : {}),
	});
}

function post<T>(url: string, body?: unknown, opts?: { signal?: AbortSignal; headers?: Record<string, string> }) {
	return request<T>(url, {
		method: "POST",
		signal: opts?.signal,
		headers: opts?.headers,
		body: body != null ? JSON.stringify(body) : undefined,
	});
}

/** The same key on a retried send makes the server return the first send instead of sending again. */
const sendKey = (key?: string) => (key ? { headers: { "Idempotency-Key": key } } : undefined);

function put<T>(url: string, body?: unknown) {
	return request<T>(url, {
		method: "PUT",
		body: body != null ? JSON.stringify(body) : undefined,
	});
}

function del<T>(url: string) {
	return request<T>(url, { method: "DELETE" });
}

// ---------- Typed response shapes ----------


export interface Conversation {
	thread_key: string;
	mailbox_id: string;
	email_id: string;
	message_id: string | null;
	state: string;
	date: string;
	sender_addr: string;
	sender_name: string;
	subject: string;
	snippet: string;
	unread: boolean;
	starred: boolean;
	has_attachment: boolean;
	can_unsubscribe: boolean;
	labels: string[];
	thread_count: number;
	thread_unread_count: number;
	participants: string[];
	has_draft: boolean;
	also_in: string[];
	/** With search words: how many of the conversation's messages matched. */
	match_count?: number;
	/** On D1: escaped text around the matched words, with <mark>. Render through snippetMarkup. */
	snippet_html?: string;
}

export interface MailPage {
	conversations: Conversation[];
	nextCursor: string | null;
	total?: number;
	unread?: number;
	order?: "relevance" | "date" | "from" | "subject";
	/** Too many matches to rank; the list is newest first. `sort:relevance` ranks it anyway. */
	rankSkipped?: boolean;
	indexing: { done: number; total: number } | null;
}

export interface FacetValue {
	value: string;
	count: number;
	name?: string;
}

export interface MailFacets {
	address: FacetValue[];
	from: { domains: FacetValue[]; addresses: FacetValue[]; more: boolean };
	label: FacetValue[];
	date: Record<"today" | "yesterday" | "7d" | "30d" | "older", number>;
	status: Record<"unread" | "read" | "starred" | "attachment" | "unsubscribe", number>;
}

export interface SuggestPerson {
	value: string;
	name?: string;
	count: number;
}

/** GET /api/v1/search/suggest: what the search window shows beyond the list (workers/lib/search-suggest-sql.ts). */
export interface Suggestions {
	completions: SuggestPerson[] | null;
	people: SuggestPerson[];
	count: number | null;
	narrow: { token: string; label: string; count: number }[];
	nothing: { everywhere: number | null; removals: { text: string; start: number; end: number; count: number }[] } | null;
	didYouMean: { text: string; words: { from: string; to: string }[] } | null;
	interpretable: boolean;
	errors: string[];
}

export interface SavedSearch {
	id: string;
	name: string;
	query: string;
	position: number;
	count?: number | null;
}

export interface Label {
	id: string;
	name: string;
	color: string;
	position: number;
	count: number;
	/** The agent has applied this label (through the chat agent or MCP). */
	auto?: boolean;
}

export interface ScheduledSend {
	mailboxId: string;
	emailId: string;
	sendAt: string;
	error: string | null;
}

export interface ScheduleRequest {
	sendAt: string;
	draft_id?: string;
	mode: "new" | "reply" | "reply-all" | "forward";
	original_id?: string;
	email: unknown;
}

export type BulkTarget =
	| { threadKeys: string[]; view: string }
	| { filter: string; asOf: string; expectedCount: number };

export interface BulkResult {
	affected: number;
	undoId: string;
	failed: { mailboxId: string; error: string }[];
}

export interface BulkJobStarted {
	jobId: string;
	total: number;
	undoId: string;
}




export interface FolderImportPlan {
	labels: { id: string; name: string; exists: boolean; folders: number; messages: number }[];
	mailboxes: { mailboxId: string; imported: boolean; folders: { folderId: string; name: string; count: number; labelId: string }[] }[];
	totals: { mailboxes: number; folders: number; messages: number };
}

export interface FolderImportResult {
	backup: string;
	plan: FolderImportPlan;
	results: { mailboxId: string; folderId: string; labelId: string; labeled: number; archived: number; error?: string }[];
}

export interface IndexCounts {
	states: Record<string, number>;
	unread: number;
	starred: number;
	total: number;
}

export interface IndexStatusResponse {
	messages: number;
	probe: string | null;
	job: {
		generation: number;
		mailboxes: string[];
		position: number;
		startedAt: string;
		finishedAt: string | null;
		error: string | null;
	} | null;
	mailboxes: {
		mailboxId: string;
		error?: string;
		source?: { mailboxId: string | null; seq: number; pending: number; counts: IndexCounts; inboxConversations: number };
		index: (IndexCounts & { inboxConversations: number; appliedSeq: number }) | null;
	}[];
}

export interface CopyCounts {
	states: Record<string, { total: number; unread: number; starred: number }>;
	labels: Record<string, number>;
	attachments: number;
	scheduled: number;
}

/** The one-time copy from the Durable Objects to D1 (workers/store/copy-job.ts). */
export interface CopyStatusResponse {
	available: boolean;
	storage: "d1" | "durable-objects";
	state: "none" | "copying" | "catching-up" | "ready" | "done";
	startedAt?: string;
	finishedAt?: string | null;
	error?: string | null;
	mailboxes: { mailboxId: string; total: number; copied: number; pagesDone: boolean }[];
	parity: {
		ok: boolean;
		checkedAt: string;
		labels: { ok: boolean; source: string[]; d1: string[] };
		mailboxes: { mailboxId: string; ok: boolean; source: CopyCounts; d1: CopyCounts; pending: number }[];
	} | null;
}

export interface AgentModelView {
	selected: ModelRef | null;
	recommended: ModelRef;
	/** The model the agent runs right now. */
	active: ModelRef;
	keys: Record<KeyedProvider, { set: boolean; hint: string }>;
}

export interface ProviderCatalog {
	source: "live" | "openrouter" | "none";
	models: CatalogModel[];
	error?: string;
}

export interface ModelCatalog {
	recommended: ModelRef;
	suggested: ModelRef[];
	providers: Record<ProviderId, ProviderCatalog>;
	keyed: KeyedProvider[];
}

// ---------- API client ----------

const api = {
	// Config
	getConfig: () =>
		get<{ domains: string[]; emailAddresses: string[]; autoDraft?: boolean }>("/api/v1/config"),

	// Agent model
	getPrefs: () => get<{ prefs: Prefs; saved: boolean }>("/api/v1/prefs"),
	savePrefs: (prefs: Partial<Prefs>) => put<{ prefs: Prefs; saved: true }>("/api/v1/prefs", prefs),
	getAgentModel: () => get<AgentModelView>("/api/v1/agent-model"),
	updateAgentModel: (body: { selected?: ModelRef | null; keys?: Partial<Record<KeyedProvider, string>> }) =>
		put<AgentModelView>("/api/v1/agent-model", body),
	testAgentModel: (body: { provider: ProviderId; id: string; key?: string }) =>
		post<{ ok: boolean; reply?: string; ms?: number; error?: string }>("/api/v1/agent-model/test", body),
	getModelCatalog: () => get<ModelCatalog>("/api/v1/agent-model/catalog"),

	// Mailboxes
	listMailboxes: () => get<Mailbox[]>("/api/v1/mailboxes"),
	createMailbox: (email: string, name: string, settings?: unknown) =>
		post<Mailbox>("/api/v1/mailboxes", { email, name, settings }),
	getMailbox: (mailboxId: string) =>
		get<Mailbox>(`/api/v1/mailboxes/${mailboxId}`),
	updateMailbox: (mailboxId: string, settings: unknown) =>
		put<Mailbox>(`/api/v1/mailboxes/${mailboxId}`, { settings }),

	// Emails
	sendEmail: (mailboxId: string, email: unknown, key?: string) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/emails`, email, sendKey(key)),
	getEmail: (mailboxId: string, id: string, opts?: { signal?: AbortSignal }) =>
		get<Email>(`/api/v1/mailboxes/${mailboxId}/emails/${id}`, { signal: opts?.signal }),
	deleteEmail: (mailboxId: string, id: string) =>
		del<void>(`/api/v1/mailboxes/${mailboxId}/emails/${id}`),
	getThread: (mailboxId: string, threadId: string, opts?: { signal?: AbortSignal }) =>
		get<Email[]>(`/api/v1/mailboxes/${mailboxId}/threads/${threadId}`, { signal: opts?.signal }),
	markThreadRead: (mailboxId: string, threadId: string) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/threads/${threadId}/read`),
	saveDraft: (
		mailboxId: string,
		draft: {
			to?: string;
			cc?: string;
			bcc?: string;
			subject?: string;
			body: string;
			in_reply_to?: string;
			thread_id?: string;
			draft_id?: string;
		},
	) => post<{ draft_id: string }>(`/api/v1/mailboxes/${mailboxId}/drafts`, draft),
	replyToEmail: (mailboxId: string, emailId: string, email: unknown, key?: string) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/emails/${emailId}/reply`, email, sendKey(key)),
	forwardEmail: (mailboxId: string, emailId: string, email: unknown, key?: string) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/emails/${emailId}/forward`, email, sendKey(key)),

	// Scheduled send
	scheduleSend: (mailboxId: string, request: ScheduleRequest) =>
		post<{ id: string; sendAt: string }>(`/api/v1/mailboxes/${mailboxId}/scheduled`, request),
	getScheduled: () => get<ScheduledSend[]>("/api/v1/mail/scheduled"),
	cancelScheduled: (mailboxId: string, emailId: string) =>
		del<{ status: string }>(`/api/v1/mailboxes/${mailboxId}/scheduled/${encodeURIComponent(emailId)}`),

	// Mail across every address
	getMail: (params: URLSearchParams, opts?: { signal?: AbortSignal }) =>
		request<MailPage>(`/api/v1/mail?${params}`, { method: "GET", signal: opts?.signal }),
	getMailFacets: (params: URLSearchParams, opts?: { signal?: AbortSignal }) =>
		request<MailFacets>(`/api/v1/mail/facets?${params}`, { method: "GET", signal: opts?.signal }),

	// Bulk actions
	bulk: (target: BulkTarget, action: BulkAction) => post<BulkResult | BulkJobStarted>("/api/v1/mail/bulk", { target, action }),
	undoBulk: (undoId: string) => post<{ affected: number }>("/api/v1/mail/bulk/undo", { undoId }),
	trashCount: () => get<{ messages: number; conversations: number }>("/api/v1/mail/trash"),
	emptyTrash: (expectedCount: number) => post<unknown>("/api/v1/mail/empty-trash", { expectedCount }),

	// Search window
	suggest: (params: URLSearchParams, opts?: { signal?: AbortSignal }) =>
		request<Suggestions>(`/api/v1/search/suggest?${params}`, { method: "GET", signal: opts?.signal }),
	getSavedSearches: (tzOffset = new Date().getTimezoneOffset()) =>
		get<SavedSearch[]>("/api/v1/saved-searches", { params: { counts: "1", tz: String(tzOffset) } }),
	createSavedSearch: (input: { name?: string; query: string }) => post<SavedSearch>("/api/v1/saved-searches", input),
	updateSavedSearch: (id: string, input: { name?: string; query?: string; position?: number }) =>
		put<SavedSearch>(`/api/v1/saved-searches/${encodeURIComponent(id)}`, input),
	deleteSavedSearch: (id: string) => del<{ deleted: boolean }>(`/api/v1/saved-searches/${encodeURIComponent(id)}`),
	/** Plain words to search text. A failure still answers, with the words themselves as the query. */
	interpretSearch: async (text: string, tz = new Date().getTimezoneOffset()): Promise<{ query: string; explanation?: string; error?: string }> => {
		try {
			return await post<{ query: string; explanation: string }>("/api/v1/search/interpret", { text, tz });
		} catch (e) {
			const body = e instanceof ApiError ? e.body : {};
			return { query: typeof body.query === "string" ? body.query : text, error: typeof body.error === "string" ? body.error : "The model didn't answer. Searching for the words instead." };
		}
	},

	// Labels
	getLabels: () => get<Label[]>("/api/v1/labels"),
	createLabel: (input: { name: string; color?: string }) => post<Label>("/api/v1/labels", input),
	updateLabel: (id: string, input: { name?: string; color?: string }) => put<Label>(`/api/v1/labels/${encodeURIComponent(id)}`, input),
	deleteLabel: (id: string) => del<{ deleted: boolean; affected: number }>(`/api/v1/labels/${encodeURIComponent(id)}`),
	importFoldersDryRun: () => post<FolderImportPlan>("/api/v1/labels/import-folders", { dryRun: true }),
	importFolders: () => post<FolderImportResult>("/api/v1/labels/import-folders", { dryRun: false, confirm: true }),

	// Mail index
	getIndexStatus: () => get<IndexStatusResponse>("/api/v1/index/status"),
	rebuildIndex: () => post<unknown>("/api/v1/index/rebuild"),
	getCopyStatus: () => get<CopyStatusResponse>("/api/v1/admin/migrate-to-d1"),
	startCopy: () => post<CopyStatusResponse>("/api/v1/admin/migrate-to-d1", { confirm: true }),

};

export default api;
