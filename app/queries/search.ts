// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiParams, type MailFilter } from "~/lib/mail-filter";
import api from "~/services/api";

export const SAVED_SEARCHES_KEY = ["saved-searches"] as const;

/**
 * The search window's suggestions for the view and chips in `filter`, the
 * box's `text` and the cursor `at` (-1 when nothing needs the server to complete).
 */
export function useSuggest(filter: MailFilter, text: string, at: number, enabled: boolean) {
	const params = apiParams(filter);
	params.set("q", text);
	if (at >= 0) params.set("at", String(at));
	return useQuery({
		queryKey: ["suggest", params.toString().replace(/&?tz=-?\d+/, "")],
		queryFn: ({ signal }) => api.suggest(params, { signal }),
		enabled,
		staleTime: 15_000,
		placeholderData: (previous) => previous,
	});
}

/** Saved searches, each with the number of conversations it matches in All mail. */
export function useSavedSearches() {
	return useQuery({ queryKey: SAVED_SEARCHES_KEY, queryFn: () => api.getSavedSearches(), refetchInterval: 60_000 });
}

function useInvalidateSaved() {
	const queryClient = useQueryClient();
	return () => queryClient.invalidateQueries({ queryKey: SAVED_SEARCHES_KEY });
}

export function useSaveSearch() {
	const invalidate = useInvalidateSaved();
	return useMutation({ mutationFn: (input: { name?: string; query: string }) => api.createSavedSearch(input), onSettled: invalidate });
}

export function useUpdateSavedSearch() {
	const invalidate = useInvalidateSaved();
	return useMutation({
		mutationFn: ({ id, ...input }: { id: string; name?: string; query?: string; position?: number }) => api.updateSavedSearch(id, input),
		onSettled: invalidate,
	});
}

export function useDeleteSavedSearch() {
	const invalidate = useInvalidateSaved();
	return useMutation({ mutationFn: (id: string) => api.deleteSavedSearch(id), onSettled: invalidate });
}
