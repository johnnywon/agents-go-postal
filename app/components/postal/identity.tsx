// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Domain identity: every domain gets a hue and a shape, derived from its
 * position in DOMAINS. The shape keeps domains apart for colour-blind readers.
 * Shapes are never round; round is reserved for the agent.
 */

const HUES = [200, 300, 30, 110];
export const SHAPES = ["square", "diamond", "triangle", "hexagon"] as const;
export type Shape = (typeof SHAPES)[number];

export interface DomainIdentity {
	domain: string;
	index: number;
	hue: number;
	shape: Shape;
}

/** Domains in DOMAINS order, then any address domain DOMAINS does not list. */
export function orderDomains(domains: string[], addresses: string[]): string[] {
	const configured = domains.map((d) => d.trim().toLowerCase()).filter(Boolean);
	const out: string[] = [];
	const add = (d: string) => {
		if (!out.includes(d)) out.push(d);
	};
	for (const d of configured) if (addresses.some((a) => domainOf(a) === d)) add(d);
	for (const a of addresses) add(domainOf(a));
	return out;
}

export function identityFor(domain: string, ordered: string[]): DomainIdentity {
	const at = ordered.indexOf(domain);
	const index = at < 0 ? ordered.length : at;
	// Past four domains the hue steps on so hue + shape stays unique.
	const hue = (HUES[index % HUES.length] + 45 * Math.floor(index / HUES.length)) % 360;
	return { domain, index, hue, shape: SHAPES[index % SHAPES.length] };
}

export function domainOf(address: string): string {
	return address.slice(address.lastIndexOf("@") + 1).toLowerCase();
}

export function handleOf(address: string): string {
	const at = address.lastIndexOf("@");
	return at < 0 ? address : address.slice(0, at);
}

/** The domain without its last label: example.com → example. */
export function shortDomain(domain: string): string {
	const parts = domain.split(".");
	return parts.length > 1 ? parts.slice(0, -1).join(".") : domain;
}

/** Inline style that colours a swatch or domain text with the domain's hue. */
export function hueVars(hue: number): React.CSSProperties {
	return { "--pg-h": String(hue) } as React.CSSProperties;
}

export function Swatch({ identity, size = 9, className = "" }: { identity: DomainIdentity; size?: 9 | 10 | 13; className?: string }) {
	return (
		<span
			aria-hidden
			className={`pg-swatch pg-shape-${identity.shape} pg-swatch-${size} ${className}`}
			style={hueVars(identity.hue)}
		/>
	);
}

/** Bold handle, muted @, domain in its hue. */
export function AddressText({
	address, identity, short = false, bold = true, className = "",
}: {
	address: string;
	identity: DomainIdentity;
	short?: boolean;
	bold?: boolean;
	className?: string;
}) {
	const domain = domainOf(address);
	return (
		<span className={`pg-addr ${className}`} title={address}>
			<span className={bold ? "pg-addr-handle" : "pg-addr-handle-plain"}>{handleOf(address)}</span>
			<span className="pg-addr-at">@</span>
			<span className="pg-addr-domain" style={hueVars(identity.hue)}>{short ? shortDomain(domain) : domain}</span>
		</span>
	);
}

/** Swatch plus address. */
export function AddressMark({
	address, identities, short, bold, size, className,
}: {
	address: string;
	identities: Identities;
	short?: boolean;
	bold?: boolean;
	size?: 9 | 10 | 13;
	className?: string;
}) {
	const identity = identities.of(address);
	return (
		<span className={`pg-addr-mark ${className ?? ""}`}>
			<Swatch identity={identity} size={size} />
			<AddressText address={address} identity={identity} short={short} bold={bold} />
		</span>
	);
}

export interface Identities {
	domains: string[];
	/** Addresses grouped by domain, in DOMAINS order. */
	groups: { identity: DomainIdentity; addresses: string[] }[];
	of: (addressOrDomain: string) => DomainIdentity;
}

export function buildIdentities(domains: string[], addresses: string[]): Identities {
	const ordered = orderDomains(domains, addresses);
	const cache = new Map(ordered.map((d) => [d, identityFor(d, ordered)]));
	const of = (value: string) => {
		const domain = value.includes("@") ? domainOf(value) : value.toLowerCase();
		let id = cache.get(domain);
		if (!id) {
			id = identityFor(domain, ordered);
			cache.set(domain, id);
		}
		return id;
	};
	return {
		domains: ordered,
		groups: ordered.map((d) => ({ identity: of(d), addresses: addresses.filter((a) => domainOf(a) === d) })),
		of,
	};
}
