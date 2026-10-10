// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Minimal SQL adapter so index SQL runs unchanged on Durable Object storage
 * and on node:sqlite in tests.
 */
export type Exec = (sql: string, ...params: unknown[]) => Record<string, unknown>[];

export function fromSqlStorage(sql: SqlStorage): Exec {
	return (query, ...params) =>
		sql.exec(query, ...(params as (string | number | null | ArrayBuffer)[])).toArray() as Record<string, unknown>[];
}
