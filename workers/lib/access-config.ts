// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The values in .dev.vars.example. The Deploy to Cloudflare button saves them
 * as the Worker's secrets, so until they are replaced Access counts as not set up.
 */
export const ACCESS_PLACEHOLDERS = {
	POLICY_AUD: "your-access-policy-audience-tag",
	TEAM_DOMAIN: "your-team.cloudflareaccess.com",
} as const;

/** True when both Access secrets are set and neither is the example placeholder. */
export function accessConfigured(env: { POLICY_AUD?: string; TEAM_DOMAIN?: string }): boolean {
	const aud = env.POLICY_AUD?.trim() ?? "";
	const team = env.TEAM_DOMAIN?.trim().toLowerCase() ?? "";
	if (!aud || !team) return false;
	return aud !== ACCESS_PLACEHOLDERS.POLICY_AUD && !team.includes(ACCESS_PLACEHOLDERS.TEAM_DOMAIN);
}
