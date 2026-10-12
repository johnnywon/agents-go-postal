// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { data, useLocation } from "react-router";
import ErrorPage from "~/components/ErrorPage";
import { pageTitle } from "~/lib/brand";

// The page renders as usual; the response carries 404 so clients and crawlers see a miss.
export function loader() {
	return data(null, { status: 404 });
}

export function meta({ matches }: { matches: Parameters<typeof pageTitle>[0] }) {
	return [{ title: pageTitle(matches, "Not found") }];
}

export default function NotFoundRoute() {
	const { pathname } = useLocation();
	return (
		<ErrorPage status={404} title="Page not found">
			Nothing lives at <code>{pathname}</code>.
		</ErrorPage>
	);
}
