// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	index,
	type RouteConfig,
	route,
} from "@react-router/dev/routes";

export default [
	index("routes/home.tsx"),
	route("mailbox/:mailboxId/*", "routes/mailbox-redirect.tsx"),
	route("mailbox/:mailboxId", "routes/mailbox-redirect.tsx", { id: "mailbox-redirect-root" }),
	route("settings", "routes/settings-redirect.tsx"),
	route("settings/index", "routes/settings-redirect.tsx", { id: "settings-index-redirect" }),
	route("*", "routes/not-found.tsx"),
] satisfies RouteConfig;
