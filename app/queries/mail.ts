// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useInfiniteQuery, useIsMutating, useQueries, useQuery } from "@tanstack/react-query";
import { apiParams, type MailFilter } from "~/lib/mail-filter";
import api from "~/services/api";

const PAGE_SIZE = 50;

/** Query key of the conversation list for a filter. */
export function mailListKey(filter: MailFilter) {
	return ["mail", apiParams(filter).toString().replace(/&?tz=-?\d+/, "")] as const;
}

/**
 * Conversations for a filter, 50 per page. Page 1 refreshes every 30 s while
 * the tab is visible, and not while a bulk action is pending.
 */
export function useMailList(filter: MailFilter) {
	const params = apiParams(filter);
	const bulkPending = useIsMutating({ mutationKey: ["bulk"] }) > 0;
	return useInfiniteQuery({
		queryKey: mailListKey(filter),
		queryFn: ({ pageParam, signal }) => {
			const page = new URLSearchParams(params);
			page.set("limit", String(PAGE_SIZE));
			if (pageParam) page.set("cursor", pageParam);
			return api.getMail(page, { signal });
		},
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (last) => last.nextCursor ?? undefined,
		refetchInterval: bulkPending ? false : 30_000,
		refetchIntervalInBackground: false,
		placeholderData: (previous) => previous,
	});
}

/** Facet counts for the filter popovers. Fetched only while a popover is open. */
export function useMailFacets(filter: MailFilter, enabled: boolean) {
	const params = apiParams(filter);
	return useQuery({
		queryKey: ["mail-facets", params.toString().replace(/&?tz=-?\d+/, "")],
		queryFn: ({ signal }) => api.getMailFacets(params, { signal }),
		enabled,
		placeholderData: (previous) => previous,
	});
}

const COUNTED_VIEWS = ["inbox", "unread", "starred"] as const;

/** Conversation counts for the source list's Inbox, Unread and Starred rows. */
export function useViewCounts() {
	const results = useQueries({
		queries: COUNTED_VIEWS.map((view) => ({
			queryKey: ["mail", "count", view],
			queryFn: ({ signal }: { signal: AbortSignal }) => api.getMail(new URLSearchParams({ view, limit: "1" }), { signal }),
			refetchInterval: 30_000,
		})),
	});
	return Object.fromEntries(COUNTED_VIEWS.map((view, i) => [view, results[i].data?.total])) as Record<
		(typeof COUNTED_VIEWS)[number],
		number | undefined
	>;
}
