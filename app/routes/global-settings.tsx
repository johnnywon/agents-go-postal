// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import DeckBrand from "~/components/DeckBrand";
import FolderImport from "~/components/FolderImport";
import LabelManager from "~/components/LabelManager";
import { queryKeys } from "~/queries/keys";
import api from "~/services/api";
import SettingsRoute from "./settings";
import { pageTitle } from "~/lib/brand";

export function meta({ matches }: { matches: Parameters<typeof pageTitle>[0] }) {
	return [{ title: pageTitle(matches, "Settings") }];
}

/** Settings for every address in one place: pick an address, edit its name, signature and agent prompt. */
export default function GlobalSettingsRoute() {
	const [params, setParams] = useSearchParams();
	const { data: config } = useQuery({ queryKey: queryKeys.config, queryFn: () => api.getConfig(), staleTime: Infinity });
	const addresses = (config?.emailAddresses ?? []).map((a) => a.toLowerCase());
	const address = params.get("address")?.toLowerCase() ?? addresses[0];
	const domains = [...new Set(addresses.map((a) => a.slice(a.lastIndexOf("@") + 1)))];

	return (
		<div className="index-settings">
			<header className="index-settings-header">
				<DeckBrand />
				<Link to="/" className="mail-link global-settings-back">Back to mail</Link>
			</header>
			<main className="settings-page index-settings-page global-settings">
				<h1 className="text-lg font-semibold">Settings</h1>
				<p className="index-settings-lede">
					<Link to="/settings/index">Mail index</Link> compares every address with the combined index.
				</p>
				<LabelManager />
				<FolderImport />
				<h2 className="mail-caption settings-address-heading">Address settings</h2>
				<label className="mail-from global-settings-address">
					<span className="mail-caption">Address</span>
					<select
						value={address ?? ""}
						onChange={(e) => setParams(new URLSearchParams({ address: e.target.value }), { replace: true })}
					>
						{domains.map((domain) => (
							<optgroup key={domain} label={domain}>
								{addresses.filter((a) => a.endsWith(`@${domain}`)).map((a) => <option key={a} value={a}>{a}</option>)}
							</optgroup>
						))}
					</select>
				</label>
				{address && <SettingsRoute key={address} mailboxId={address} />}
			</main>
		</div>
	);
}
