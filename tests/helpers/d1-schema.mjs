import { readdirSync, readFileSync } from "node:fs";

/** Every D1 migration in order, as one script: the schema a deployment has after `wrangler d1 migrations apply`. */
export const D1_SCHEMA = readdirSync("migrations")
	.filter((f) => /^\d{4}_.*\.sql$/.test(f))
	.sort()
	.map((f) => readFileSync(`migrations/${f}`, "utf8"))
	.join("\n");
