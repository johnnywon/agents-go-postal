import { DatabaseSync } from "node:sqlite";

// Async `Sql` (workers/store/sql.ts) over node:sqlite for unit tests. It
// refuses what D1 refuses: more than 100 bound parameters, SQL-level
// transactions, a value over 8 MB, and a batch over 32 MiB.

const MAX_PARAMS = 100;
const MAX_VALUE_BYTES = 8 * 1000 * 1000;
const MAX_BATCH_BYTES = 32 * 1024 * 1024;

function sizeOf(value) {
	if (typeof value === "string") return Buffer.byteLength(value);
	if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value.byteLength;
	return 8;
}

function check(sql, params) {
	if (/^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/im.test(sql)) throw new Error("SQL transactions are not allowed");
	if (params.length > MAX_PARAMS) throw new Error(`too many SQL variables: ${params.length}`);
	for (const value of params) {
		if (sizeOf(value) > MAX_VALUE_BYTES) throw new Error("string or blob too big: SQLITE_TOOBIG");
	}
}

export function openSql() {
	const db = new DatabaseSync(":memory:");
	db.exec("PRAGMA foreign_keys = ON");
	const exec = (sql, params = []) => {
		check(sql, params);
		const stmt = db.prepare(sql);
		if (stmt.columns().length > 0) return stmt.all(...params).map((row) => ({ ...row }));
		const result = stmt.run(...params);
		return Object.assign([], { changes: Number(result.changes) });
	};
	const sql = {
		async all(text, ...params) {
			return exec(text, params);
		},
		async first(text, ...params) {
			return exec(text, params)[0] ?? null;
		},
		async run(text, ...params) {
			const rows = exec(text, params);
			return { changes: rows.changes ?? 0 };
		},
		async batch(statements) {
			const bytes = statements.reduce((n, s) => n + Buffer.byteLength(s.sql) + (s.params ?? []).reduce((m, v) => m + sizeOf(v), 0), 0);
			if (bytes > MAX_BATCH_BYTES) throw new Error(`Serialized RPC arguments or return values are limited to 32MiB, but the size of this value was: ${bytes} bytes.`);
			db.exec("BEGIN");
			try {
				const results = statements.map((s) => [...exec(s.sql, s.params ?? [])]);
				db.exec("COMMIT");
				return results;
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		},
		/** Multi-statement schema SQL with no parameters, like a migration file. */
		async schema(text) {
			db.exec(text);
		},
	};
	return { db, sql };
}
