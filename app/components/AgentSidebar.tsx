// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Loader } from "@cloudflare/kumo";
import { PlugsIcon, RobotIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import MCPPanel from "./MCPPanel";

function LazyAgentPanel({ mailboxId }: { mailboxId?: string }) {
	const [AgentChat, setAgentChat] = useState<React.ComponentType<{ mailboxId?: string }> | null>(
		null,
	);
	const [loadError, setLoadError] = useState<string | null>(null);

	useEffect(() => {
		import("~/components/AgentPanel").then((mod) => {
			setAgentChat(() => mod.default);
		}).catch((err) => {
			console.error("Failed to load AgentPanel:", err);
			setLoadError("Failed to load agent panel");
		});
	}, []);

	if (loadError) {
		return (
			<div className="flex items-center justify-center h-full">
				<span className="text-xs text-kumo-error">{loadError}</span>
			</div>
		);
	}
	if (!AgentChat) {
		return (
			<div className="flex flex-col items-center justify-center h-full gap-2">
				<Loader size="base" />
				<span className="text-xs text-kumo-subtle">Loading agent...</span>
			</div>
		);
	}
	return <AgentChat mailboxId={mailboxId} />;
}

/** `mailboxId` binds the agent outside /mailbox/:id; inside, the route param is used. */
export default function AgentSidebar({ mailboxId }: { mailboxId?: string } = {}) {
	const [activeTab, setActiveTab] = useState<"agent" | "mcp">("agent");

	return (
		<div className="flex flex-col h-full">
			{/* Tab bar */}
			<div className="flex items-center gap-1 border-b border-kumo-line px-2 py-2 shrink-0">
				<button
					type="button"
					onClick={() => setActiveTab("agent")}
					aria-pressed={activeTab === "agent"}
					className={`flex items-center gap-1.5 px-3 py-1.5 text-sm transition-colors cursor-pointer ${
						activeTab === "agent"
							? "bg-kumo-fill font-semibold text-kumo-default ring-1 ring-inset ring-kumo-line"
							: "font-medium text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default"
					}`}
				>
					<RobotIcon size={14} weight={activeTab === "agent" ? "fill" : "regular"} />
					Agent
				</button>
				<button
					type="button"
					onClick={() => setActiveTab("mcp")}
					aria-pressed={activeTab === "mcp"}
					className={`flex items-center gap-1.5 px-3 py-1.5 text-sm transition-colors cursor-pointer ${
						activeTab === "mcp"
							? "bg-kumo-fill font-semibold text-kumo-default ring-1 ring-inset ring-kumo-line"
							: "font-medium text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default"
					}`}
				>
					<PlugsIcon size={14} weight={activeTab === "mcp" ? "fill" : "regular"} />
					MCP
				</button>
			</div>

			{/* Tab content — keep agent mounted so chat isn't lost */}
			<div className="flex-1 min-h-0 overflow-hidden">
				<div className={activeTab === "agent" ? "h-full" : "hidden"}>
					<LazyAgentPanel mailboxId={mailboxId} />
				</div>
				{activeTab === "mcp" && <MCPPanel />}
			</div>
		</div>
	);
}
