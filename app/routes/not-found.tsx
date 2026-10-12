// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Link, useLocation } from "react-router";
import SettingsHeader from "~/components/SettingsHeader";
import { pageTitle } from "~/lib/brand";

export function meta({ matches }: { matches: Parameters<typeof pageTitle>[0] }) {
	return [{ title: pageTitle(matches, "Not found") }];
}

export default function NotFoundRoute() {
	const { pathname } = useLocation();
	return (
		<div className="index-settings">
			<SettingsHeader />
			<main className="settings-page index-settings-page">
				<img className="deck-brand-logo not-found-logo" src="/brand/watermark.svg" alt="" width={741} height={282} />
				<h1 className="text-lg font-semibold">Page not found</h1>
				<p className="index-settings-lede">Nothing lives at {pathname}.</p>
				<Link to="/" className="mail-link">Back to mail</Link>
			</main>
		</div>
	);
}
