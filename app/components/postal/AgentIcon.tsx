// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { CSSProperties } from "react";

/**
 * The agent: a robot with the logo's cursor blocks for eyes and an @ on its
 * antenna. The shell takes the current colour; the eyes are always agent green.
 * Takes Phosphor's props so it can stand in for a Phosphor icon; weight is ignored.
 */
export function AgentIcon({ size = 16, color, className, style }: {
	size?: number;
	weight?: string;
	color?: string;
	className?: string;
	style?: CSSProperties;
}) {
	return (
		<svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} style={{ color, flex: "none", ...style }} aria-hidden="true">
			<circle cx="12" cy="4.4" r="1.1" stroke="currentColor" strokeWidth="1.2" />
			<path d="M13.1 3.7v1.3a.9.9 0 0 0 1.8 0v-.6a2.9 2.9 0 1 0-1.2 2.3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
			<path d="M12 7.8V10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
			<rect x="4" y="10" width="16" height="11" rx="3" stroke="currentColor" strokeWidth="2" />
			<rect x="8" y="13" width="2.4" height="4.5" fill="var(--pg-green)" />
			<rect x="13.6" y="13" width="2.4" height="4.5" fill="var(--pg-green)" />
		</svg>
	);
}
