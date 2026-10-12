// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { redirect } from "react-router";

/** The old settings pages now open as tabs of the Settings dialog in the mail view. */
export function loader({ request }: { request: Request }) {
	const { pathname } = new URL(request.url);
	return redirect(pathname.replace(/\/+$/, "") === "/settings/index" ? "/?settings=storage" : "/?settings=labels");
}

export default function SettingsRedirect() {
	return null;
}
