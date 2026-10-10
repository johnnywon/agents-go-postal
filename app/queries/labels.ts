// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import api, { type Label } from "~/services/api";

export const LABELS_KEY = ["labels"] as const;

/** Label definitions with conversation counts, shared by every address. */
export function useLabels() {
	const query = useQuery({ queryKey: LABELS_KEY, queryFn: () => api.getLabels(), refetchInterval: 60_000 });
	const labels = query.data ?? [];
	const byId = useMemo(() => new Map(labels.map((l) => [l.id, l])), [labels]);
	const names = useMemo(() => new Map(labels.map((l) => [l.id, l.name])), [labels]);
	return { ...query, labels, byId, names };
}

function useInvalidateLabels() {
	const queryClient = useQueryClient();
	return () => {
		queryClient.invalidateQueries({ queryKey: LABELS_KEY });
		queryClient.invalidateQueries({ queryKey: ["mail"] });
		queryClient.invalidateQueries({ queryKey: ["mail-facets"] });
	};
}

export function useCreateLabel() {
	const invalidate = useInvalidateLabels();
	return useMutation({ mutationFn: (input: { name: string; color?: string }) => api.createLabel(input), onSettled: invalidate });
}

export function useUpdateLabel() {
	const invalidate = useInvalidateLabels();
	return useMutation({
		mutationFn: ({ id, ...input }: { id: string; name?: string; color?: string }) => api.updateLabel(id, input),
		onSettled: invalidate,
	});
}

export function useDeleteLabel() {
	const invalidate = useInvalidateLabels();
	return useMutation({ mutationFn: (id: string) => api.deleteLabel(id), onSettled: invalidate });
}

export type { Label };
