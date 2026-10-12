// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { createRemoteJWKSet } from "jose";

/**
 * The values in .dev.vars.example. The Deploy to Cloudflare button saves them
 * as the Worker's secrets, so until they are replaced Access counts as not set up.
 */
export const ACCESS_PLACEHOLDERS = {
	POLICY_AUD: "your-access-policy-audience-tag",
	TEAM_DOMAIN: "your-team.cloudflareaccess.com",
} as const;

export function accessConfigError(env: { POLICY_AUD?: string; TEAM_DOMAIN?: string }): string | null {
	const aud = env.POLICY_AUD?.trim() ?? "";
	const team = env.TEAM_DOMAIN?.trim() ?? "";
	if (!aud) return "POLICY_AUD is missing";
	if (aud === ACCESS_PLACEHOLDERS.POLICY_AUD) return "POLICY_AUD is still the example placeholder";
	if (!team) return "TEAM_DOMAIN is missing";
	if (team.toLowerCase().includes(ACCESS_PLACEHOLDERS.TEAM_DOMAIN)) {
		return "TEAM_DOMAIN is still the example placeholder";
	}

	try {
		const url = new URL(team);
		if (url.protocol === "https:" && url.hostname) return null;
	} catch {
		// The domain must be a complete HTTPS URL.
	}
	return "TEAM_DOMAIN must be an https:// URL with a hostname";
}

export function accessConfigured(env: { POLICY_AUD?: string; TEAM_DOMAIN?: string }): boolean {
	return accessConfigError(env) === null;
}

export function getAccessUrls(teamDomain: string): { issuer: string; certsUrl: URL } {
	const certsPath = "/cdn-cgi/access/certs";
	const teamUrl = new URL(teamDomain);
	const issuer = teamUrl.origin;
	const certsUrl = teamUrl.pathname.endsWith(certsPath)
		? teamUrl
		: new URL(certsPath, issuer);
	return { issuer, certsUrl };
}

const jwksByUrl = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export function accessJwks(certsUrl: URL): ReturnType<typeof createRemoteJWKSet> {
	const key = certsUrl.toString();
	let jwks = jwksByUrl.get(key);
	if (!jwks) {
		jwks = createRemoteJWKSet(certsUrl);
		jwksByUrl.set(key, jwks);
	}
	return jwks;
}
