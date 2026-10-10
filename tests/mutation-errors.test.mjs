import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTs } from "./helpers/sqlite.mjs";

const { shouldLogMutationError } = await loadTs("app/lib/mutation-errors.ts");

test("errors a mutation declares it handles are not logged", () => {
	assert.equal(shouldLogMutationError({ status: 409 }, { handledStatuses: [409] }), false);
	assert.equal(shouldLogMutationError({ status: 500 }, { handledStatuses: [409] }), true);
	assert.equal(shouldLogMutationError({ status: 409 }, undefined), true);
	assert.equal(shouldLogMutationError(new Error("offline"), { handledStatuses: [409] }), true);
	assert.equal(shouldLogMutationError(null, { handledStatuses: [409] }), true);
});
