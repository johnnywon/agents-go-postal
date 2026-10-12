// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import FolderImport from "~/components/FolderImport";
import LabelManager from "~/components/LabelManager";
import SettingsHeader from "~/components/SettingsHeader";
import { pageTitle } from "~/lib/brand";

export function meta({ matches }: { matches: Parameters<typeof pageTitle>[0] }) {
	return [{ title: pageTitle(matches, "Labels") }];
}

/** Rename, recolour and delete labels, and turn old folders into labels. Address settings live in the mail view's Settings. */
export default function GlobalSettingsRoute() {
	return (
		<div className="index-settings">
			<SettingsHeader />
			<main className="settings-page index-settings-page global-settings">
				<h1 className="text-lg font-semibold">Labels</h1>
				<LabelManager />
				<FolderImport />
			</main>
		</div>
	);
}
