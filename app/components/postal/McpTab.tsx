// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { ArrowSquareOutIcon, MagnifyingGlassIcon, PlugsConnectedIcon, ShieldCheckIcon, WrenchIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { MCP_GROUPS, MCP_TOOLS, type McpToolGroup } from "shared/mcp-tools";
import api, { type McpUsage } from "~/services/api";
import type { ConsoleTab } from "./console-tabs";
import { Async, Badge, Button, Code, CopyField, Name, Note, Section, Table, Tabs } from "./ConsoleUI";

/** Production sits behind Cloudflare Access, so clients send a service token. The dev server has no Access. */
const BEHIND_ACCESS = !import.meta.env.DEV;

const ID = "CF_ACCESS_CLIENT_ID";
const SECRET = "CF_ACCESS_CLIENT_SECRET";

type Client = "claude-code" | "claude-desktop" | "cursor" | "curl";

const CLIENTS: { value: Client; label: string }[] = [
	{ value: "claude-code", label: "Claude Code" },
	{ value: "claude-desktop", label: "Claude Desktop" },
	{ value: "cursor", label: "Cursor" },
	{ value: "curl", label: "curl" },
];

const json = (v: unknown) => JSON.stringify(v, null, 2);

/** What to run or paste for each client, with the token headers when Access is in front. */
function setup(client: Client, url: string): { lang: "sh" | "json"; title: string; code: string } {
	switch (client) {
		case "claude-code":
			return {
				lang: "sh", title: "terminal",
				code: BEHIND_ACCESS
					? `claude mcp add --transport http pluramail ${url} \\\n  --header "CF-Access-Client-Id: $${ID}" \\\n  --header "CF-Access-Client-Secret: $${SECRET}"`
					: `claude mcp add --transport http pluramail ${url}`,
			};
		case "claude-desktop":
			return {
				lang: "json", title: "claude_desktop_config.json",
				code: json({
					mcpServers: {
						pluramail: BEHIND_ACCESS
							? {
								command: "npx",
								args: ["-y", "mcp-remote", url, "--header", `CF-Access-Client-Id:\${${ID}}`, "--header", `CF-Access-Client-Secret:\${${SECRET}}`],
								env: { [ID]: "<client id>", [SECRET]: "<client secret>" },
							}
							: { command: "npx", args: ["-y", "mcp-remote", url] },
					},
				}),
			};
		case "cursor":
			return {
				lang: "json", title: "~/.cursor/mcp.json",
				code: json({
					mcpServers: {
						pluramail: BEHIND_ACCESS
							? { url, headers: { "CF-Access-Client-Id": `\${env:${ID}}`, "CF-Access-Client-Secret": `\${env:${SECRET}}` } }
							: { url },
					},
				}),
			};
		case "curl": {
			const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "curl", version: "1" } } });
			const auth = BEHIND_ACCESS ? `  -H "CF-Access-Client-Id: $${ID}" \\\n  -H "CF-Access-Client-Secret: $${SECRET}" \\\n` : "";
			return {
				lang: "sh", title: "terminal",
				code: `curl -sS ${url} \\\n  -H "Content-Type: application/json" \\\n  -H "Accept: application/json, text/event-stream" \\\n${auth}  -d '${body}'`,
			};
		}
	}
}

/** "just now", "4m ago", "3h ago", "2d ago". */
export function ago(iso: string, now = Date.now()): string {
	const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
	if (s < 45) return "just now";
	if (s < 3600) return `${Math.round(s / 60)}m ago`;
	if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
	return `${Math.round(s / 86_400)}d ago`;
}

const GROUP_BADGE: Record<McpToolGroup, { tone: "ok" | "neutral" | "danger"; label: string }> = {
	read: { tone: "ok", label: "Read-only" },
	write: { tone: "neutral", label: "Writes" },
	send: { tone: "danger", label: "High impact" },
	app: { tone: "neutral", label: "Local" },
};

/** One dashed hop in the wire, drawn so it animates and turns on narrow screens. */
function Hop() {
	return (
		<svg className="pg-mcp-hop" viewBox="0 0 48 8" preserveAspectRatio="none" aria-hidden>
			<line x1="0" y1="4" x2="42" y2="4" />
			<path d="M41 1 L46 4 L41 7" />
		</svg>
	);
}

/** The path a call takes: client, Access, the server, the tools. Numbers ride on the nodes. */
function Wire({ usage }: { usage: McpUsage | undefined }) {
	const clients = usage?.clients.length ?? 0;
	const today = usage?.clients.reduce((n, c) => n + c.today, 0) ?? 0;
	return (
		<ol className="pg-mcp-wire" aria-label="How a call reaches your mail">
			<li data-on={clients > 0 || undefined}>
				<PlugsConnectedIcon size={14} />
				<b>{clients ? `${clients} client${clients === 1 ? "" : "s"}` : "Your client"}</b>
				<span>{usage?.clients[0]?.client ?? "JSON-RPC over HTTP"}</span>
			</li>
			<Hop />
			<li data-off={!BEHIND_ACCESS || undefined}>
				<ShieldCheckIcon size={14} />
				<b>Access</b>
				<span>{BEHIND_ACCESS ? "service token" : "off in dev"}</span>
			</li>
			<Hop />
			<li data-on>
				<span className="pg-mcp-live" aria-hidden />
				<b>/mcp</b>
				<span>{today} call{today === 1 ? "" : "s"} today</span>
			</li>
			<Hop />
			<li>
				<WrenchIcon size={14} />
				<b>{MCP_TOOLS.length} tools</b>
				<span>{MCP_GROUPS.length} groups</span>
			</li>
		</ol>
	);
}

/** Console > MCP: the server, how to connect each client, who has connected, and every tool by impact. */
export function McpTab({ onTab }: { onTab: (tab: ConsoleTab) => void }) {
	const url = `${window.location.origin}/mcp`;
	const usage = useQuery({ queryKey: ["mcp-usage"], queryFn: () => api.getMcpUsage(), refetchInterval: 15_000 });
	const [client, setClient] = useState<Client>("claude-code");
	const [filter, setFilter] = useState("");
	const step = setup(client, url);
	const q = filter.trim().toLowerCase();
	const shown = MCP_TOOLS.filter((t) => !q || t.name.includes(q.replace(/\s+/g, "_")) || t.summary.toLowerCase().includes(q));
	const last = usage.data?.lastCall;

	return (
		<>
			<div className="pg-mcp-server">
				<div className="pg-mcp-status">
					<Badge tone="ok" live>Live</Badge>
					<span>Streamable HTTP · MCP 2025-06-18</span>
					<span className="pg-flex" />
					<span>{last ? `last call ${ago(last)}` : "no calls yet"}</span>
				</div>
				<CopyField value={url} label="MCP server URL" />
				<Wire usage={usage.data} />
			</div>

			<Section title="Connect a client">
				<Tabs value={client} options={CLIENTS} onChange={setClient} />
				<ol className="pg-mcp-steps">
					{BEHIND_ACCESS && (
						<li>
							<b>Make a service token</b>
							<p>
								Zero Trust › Access › Service credentials. Add a Service Auth policy for it on this app. Export{" "}
								<code className="pg-mono">{ID}</code> and <code className="pg-mono">{SECRET}</code>.{" "}
								<a href="https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/" target="_blank" rel="noreferrer">
									Service tokens <ArrowSquareOutIcon size={11} />
								</a>
							</p>
						</li>
					)}
					<li>
						<b>{client === "curl" ? "Handshake" : "Add the server"}</b>
						<Code lang={step.lang} title={step.title}>{step.code}</Code>
					</li>
				</ol>
			</Section>

			<Section
				title="Clients"
				actions={<Button size="sm" variant="quiet" onClick={() => onTab("logs")}>Activity log</Button>}
			>
				<Async query={usage} empty="No clients yet." isEmpty={(d) => d.clients.length === 0}>
					{(d) => (
						<Table
							label="MCP clients"
							rows={d.clients}
							rowKey={(r) => r.client ?? "(unnamed)"}
							onRow={() => onTab("logs")}
							columns={[
								{ key: "client", label: "Client", head: true, cell: (r) => <Name icon={<PlugsConnectedIcon size={14} />}>{r.client ?? "Unnamed client"}</Name> },
								{ key: "last", label: "Last call", cell: (r) => <span className="pg-mono">{ago(r.last)}</span> },
								{ key: "today", label: "24h", num: true, quiet: (r) => r.today === 0, cell: (r) => r.today },
								{ key: "calls", label: "Calls", num: true, wide: true, cell: (r) => r.calls },
								{ key: "errors", label: "Errors", num: true, quiet: (r) => r.errors === 0, bad: (r) => r.errors > 0, cell: (r) => r.errors },
							]}
						/>
					)}
				</Async>
			</Section>

			<Section
				title={`Tools · ${MCP_TOOLS.length}`}
				actions={
					<label className="pg-mcp-filter">
						<MagnifyingGlassIcon size={12} />
						<input type="search" placeholder="Filter tools" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter tools" />
					</label>
				}
			>
				{shown.length === 0 && <Note>No matches.</Note>}
				{MCP_GROUPS.map((g) => {
					const tools = shown.filter((t) => t.group === g.id);
					if (tools.length === 0) return null;
					const badge = GROUP_BADGE[g.id];
					return (
						<div key={g.id} className="pg-mcp-group" data-group={g.id}>
							<div className="pg-mcp-group-head">
								<b>{g.label}</b>
								<em>{tools.length}</em>
								<Badge tone={badge.tone}>{badge.label}</Badge>
							</div>
							<ul className="pg-mcp-tools">
								{tools.map((t) => {
									const used = usage.data?.tools[t.name];
									return (
										<li key={t.name} data-unused={!used || undefined}>
											<code>{t.name}</code>
											<span>{t.summary}</span>
											<em>{used ? `${used.calls} call${used.calls === 1 ? "" : "s"} · ${ago(used.last)}` : "not called"}</em>
										</li>
									);
								})}
							</ul>
						</div>
					);
				})}
			</Section>
		</>
	);
}
