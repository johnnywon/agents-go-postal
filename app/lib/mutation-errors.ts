// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The global mutation logger skips errors a mutation declared it handles,
 * through `meta: { handledStatuses: [409] }`.
 */
export function shouldLogMutationError(error: unknown, meta: Record<string, unknown> | undefined): boolean {
	const handled = meta?.handledStatuses;
	const status = (error as { status?: unknown } | null)?.status;
	return !(Array.isArray(handled) && typeof status === "number" && handled.includes(status));
}
