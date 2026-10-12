// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { NavLink } from "react-router";
import DeckBrand from "~/components/DeckBrand";

/** The brand and the links between mail and the settings pages. */
export default function SettingsHeader() {
	return (
		<header className="index-settings-header">
			<DeckBrand />
			<nav className="settings-nav" aria-label="Settings">
				<NavLink to="/" className="mail-link">Back to mail</NavLink>
				<NavLink to="/settings" end className="mail-link">Labels</NavLink>
				<NavLink to="/settings/index" className="mail-link">Mail index</NavLink>
			</nav>
		</header>
	);
}
