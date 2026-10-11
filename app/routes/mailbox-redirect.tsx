// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { redirect } from "react-router";
import { legacyRedirect } from "~/lib/mail-filter";

/** Old per-mailbox links (/mailbox/<address>/...) open the same mail in the mail view. */
export function loader({ request }: { request: Request }) {
	const url = new URL(request.url);
	return redirect(legacyRedirect(url.pathname, url.search) ?? "/");
}

export default function MailboxRedirect() {
	return null;
}
