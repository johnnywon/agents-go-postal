// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Idempotency keys for sends, stored per mailbox in the send_keys table. A key
 * is claimed before delivery and marked sent once the Sent copy is stored, so
 * a retry with the same key returns the first result instead of sending twice.
 *
 * A key whose send failed before delivery is released and can be used again.
 * A key whose send may have been delivered stays pending: a retry is refused
 * rather than risk a second copy.
 */

export const SEND_KEY_MAX_LENGTH = 200;
export const SEND_KEY_TTL_MS = 7 * 24 * 60 * 60_000;

export type SendKeyClaim =
	| { state: "new" }
	| { state: "sent"; id: string }
	| { state: "pending" };

export const SEND_KEY_PENDING_ERROR =
	"A send with this idempotency key is in progress or did not finish. Check Sent before sending again.";

/** Null when the key is usable, else the error to show. */
export function checkSendKey(key: string): string | null {
	if (!key.trim()) return "Idempotency key is empty";
	if (key.length > SEND_KEY_MAX_LENGTH) return `Idempotency key is longer than ${SEND_KEY_MAX_LENGTH} characters`;
	return null;
}
