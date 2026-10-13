// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

// The Alex profile's people and companies. Partwell, its customers, vendors
// and Alex's friends are invented for the story. GitHub, Cloudflare, Stripe,
// Supabase and Uber Eats appear as the senders of simulated notices: none of
// that mail came from them, and nothing here contacts them.

import type { Box, Person } from "../kit";

export const ALEX_BOXES = ["hello", "support", "billing", "partners", "ops", "personal", "league"] as const satisfies readonly Box[];
export type AlexBox = (typeof ALEX_BOXES)[number];

/** Every mailbox the profile writes to, named outright: there is no fallback that could fold two into one. */
export const ALEX_ADDRESSES: Record<AlexBox, string> = {
	hello: "hello@partwell.dev",
	support: "support@partwell.dev",
	billing: "billing@partwell.dev",
	partners: "partners@partwell.dev",
	ops: "ops@partwell.dev",
	personal: "alex@alexrivera.me",
	league: "league@alexrivera.me",
};

/** How each mailbox signs its mail (Settings > Mailboxes, From name). */
export const ALEX_FROM_NAMES: Record<AlexBox, string> = {
	hello: "Alex Rivera",
	support: "Partwell Support",
	billing: "Partwell Billing",
	partners: "Alex Rivera",
	ops: "Partwell Ops",
	personal: "Alex Rivera",
	league: "Alex Rivera",
};

/** The mailbox as mail arrives to it. */
export const box = (b: AlexBox): Person => ({ name: { hello: "Partwell", support: "Partwell Support", billing: "Partwell Billing", partners: "Partwell Partners", ops: "Partwell Ops", personal: "Alex Rivera", league: "Alex Rivera" }[b], addr: ALEX_ADDRESSES[b] });

/** Alex writing from a mailbox. */
export const alex = (b: AlexBox): Person => ({ name: "Alex Rivera", addr: ALEX_ADDRESSES[b] });

const p = (name: string, addr: string): Person => ({ name, addr });

export const P = {
	ben: p("Ben Ortiz", "ben@northlineparts.com"),
	nora: p("Nora Bell", "nora@northlineparts.com"),
	lena: p("Lena Park", "lena@cedarsupply.co"),
	omar: p("Omar Reed", "omar@cedarsupply.co"),
	priya: p("Priya Shah", "priya@priyashah.dev"),
	tess: p("Tess Morgan", "tess@morganledger.com"),
	mara: p("Mara Lewis", "mara@westhavenstudio.co"),
	sofia: p("Sofia Chen", "sofia@supabase.com"),
	supabase: p("Supabase Support", "support@supabase.com"),
	theo: p("Theo Martin", "theo@atlasdataworks.io"),
	evelyn: p("Evelyn Brooks", "evelyn@fieldstonecatalogs.com"),
	fieldstone: p("Fieldstone Catalogs", "renewals@fieldstonecatalogs.com"),
	eli: p("Eli Santos", "eli@procuraworks.io"),
	june: p("June Park", "june@harborassembly.co"),
	miles: p("Miles at Launchboard", "miles@launchboardlistings.com"),
	maya: p("Maya Chen", "maya@sundaycrew.email"),
	nia: p("Nia Brooks", "nia@sundaycrew.email"),
	sam: p("Sam Patel", "sam@sundaycrew.email"),
	jordan: p("Jordan Ellis", "jordan@sundaydeployleague.com"),
	league: p("Sunday Deploy League", "updates@sundaydeployleague.com"),
	github: p("GitHub", "notifications@github.com"),
	cloudflare: p("Cloudflare", "alerts@cloudflare.com"),
	stripe: p("Stripe", "receipts@stripe.com"),
	ubereats: p("Uber Eats", "orders@ubereats.com"),
	keyforge: p("Keyforge Keys Orders", "orders@keyforgekeys.com"),
	buildnotes: p("Build Notes", "editor@buildnotes.news"),
};

/** Brand colours for the simulated notices' wordmarks. A letter and a name, never a logo. */
export const BRAND = {
	github: "#24292f",
	cloudflare: "#c2410c",
	stripe: "#635bff",
	ubereats: "#0b7a3b",
	keyforge: "#3b3f8f",
	buildnotes: "#7a5a3a",
	league: "#1f6f43",
	fieldstone: "#6b4f2a",
	launchboard: "#c2410c",
};
