// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { createContext, useContext } from "react";

/** True on a demo build (PLURAMAIL_DEMO=1, /api/v1/config says so): no agent and no sign-in, so their controls are hidden. */
export const DemoContext = createContext(false);

export function useDemo(): boolean {
	return useContext(DemoContext);
}
