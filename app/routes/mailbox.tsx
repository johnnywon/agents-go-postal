// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { Navigate, Outlet, useLocation, useParams } from "react-router";
import AgentSidebar from "~/components/AgentSidebar";
import ComposeEmail from "~/components/ComposeEmail";
import Header from "~/components/Header";
import Sidebar from "~/components/Sidebar";
import { legacyRedirect } from "~/lib/mail-filter";
import { queryKeys } from "~/queries/keys";
import { useMailbox } from "~/queries/mailboxes";
import api from "~/services/api";
import { useUIStore } from "~/hooks/useUIStore";

export default function MailboxRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const location = useLocation();
	const requestedEmailId = new URLSearchParams(location.search).get("email");
	// Prefetch mailbox data for child components
	useMailbox(mailboxId);
	const prevMailboxIdRef = useRef<string | undefined>(undefined);
	const {
		isSidebarOpen,
		closeSidebar,
		isAgentPanelOpen,
		closePanel,
		closeComposeModal,
		selectEmail,
		startCompose,
	} = useUIStore();

	useEffect(() => {
		if (
			prevMailboxIdRef.current &&
			mailboxId &&
			prevMailboxIdRef.current !== mailboxId
		) {
			closePanel();
			closeComposeModal();
			closeSidebar();
		}

		prevMailboxIdRef.current = mailboxId;
		if (requestedEmailId) selectEmail(requestedEmailId);
		if (new URLSearchParams(location.search).get("compose") === "new") startCompose();
	}, [mailboxId, requestedEmailId, closeComposeModal, closePanel, closeSidebar, selectEmail, startCompose, location.search]);

	const { data: config } = useQuery({ queryKey: queryKeys.config, queryFn: () => api.getConfig(), staleTime: Infinity });
	const unified = config?.mailUi === "unified";
	const { data: labels } = useQuery({ queryKey: ["labels"], queryFn: () => api.getLabels(), enabled: unified });
	if (!config || (unified && !labels)) return <div className="flex h-dvh bg-kumo-recessed" />;
	// Under the unified view, every classic mailbox URL lands on its filtered equivalent.
	if (unified) {
		const target = legacyRedirect(location.pathname, location.search, new Set(labels!.map((l) => l.id)));
		if (target) return <Navigate to={target} replace />;
	}

	return (
		<div className="mailbox-deck flex h-dvh overflow-hidden">
			{/* Mobile sidebar overlay backdrop */}
			{isSidebarOpen && (
				<div
					className="fixed inset-0 z-30 bg-black/30 md:hidden"
					onClick={closeSidebar}
					onKeyDown={(e) => e.key === "Escape" && closeSidebar()}
					role="button"
					tabIndex={-1}
					aria-label="Close sidebar"
				/>
			)}

			{/* Sidebar: hidden on mobile by default, shown as overlay when open */}
			<div
				className={`mailbox-nav-container fixed inset-y-0 left-0 z-40 w-64 transform transition-transform duration-200 ease-in-out md:relative md:translate-x-0 md:z-0 ${
					isSidebarOpen ? "translate-x-0 visible" : "-translate-x-full invisible md:visible"
				}`}
			>
				<Sidebar />
			</div>

			{/* Main content */}
			<div className="flex-1 flex flex-col min-w-0 bg-kumo-base">
				<Header />
				<main className="flex-1 overflow-hidden">
					<Outlet />
				</main>
			</div>

			{/* Agent + MCP sidebar -- togglable on desktop */}
			{isAgentPanelOpen && (
				<div className="agent-drawer hidden lg:flex w-[320px] shrink-0 border-l border-kumo-line flex-col bg-kumo-base overflow-hidden">
					<AgentSidebar />
				</div>
			)}

			<ComposeEmail />
		</div>
	);
}
