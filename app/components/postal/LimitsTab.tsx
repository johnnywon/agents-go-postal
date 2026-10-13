// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { AGENT_LIMIT_RANGES, type AgentLimits, DEFAULT_AGENT_LIMITS, SEND_LIMITS } from "shared/send-limits";
import api from "~/services/api";

type Key = keyof AgentLimits;

const FIELDS: { key: Key; title: string; sub: string; unit: string }[] = [
	{ key: "agentDay", title: "Agent sends a day", sub: "Per address, by the agent and MCP clients together. 0 stops agent sending.", unit: "messages" },
	{ key: "agentRecipients", title: "Recipients per agent message", sub: "To, Cc and Bcc together.", unit: "recipients" },
	{ key: "autoDraftPerSender", title: "Auto-drafts per sender a day", sub: "Per address. Later mail from that sender is stored but not drafted. 0 stops auto-drafting.", unit: "drafts" },
];

/** The saved limits and an edit in progress, saved by the console's Save button. */
export function useAgentLimitsDraft() {
	const queryClient = useQueryClient();
	const saved = useQuery({ queryKey: ["agent-limits"], queryFn: () => api.getAgentLimits() });
	const [edits, setEdits] = useState<Partial<Record<Key, string>>>({});
	const base = saved.data ?? DEFAULT_AGENT_LIMITS;
	const text = (key: Key) => edits[key] ?? String(base[key]);
	const problem = (key: Key) => {
		const n = Number(text(key));
		const { min, max } = AGENT_LIMIT_RANGES[key];
		return Number.isInteger(n) && n >= min && n <= max ? null : `Use a whole number from ${min} to ${max}`;
	};
	const dirty = FIELDS.some(({ key }) => edits[key] !== undefined && text(key) !== String(base[key]));
	const save = async () => {
		const bad = FIELDS.find(({ key }) => problem(key));
		if (bad) throw new Error(`${bad.title}: ${problem(bad.key)}`);
		const next = Object.fromEntries(FIELDS.map(({ key }) => [key, Number(text(key))])) as unknown as AgentLimits;
		await api.putAgentLimits(next);
		await queryClient.invalidateQueries({ queryKey: ["agent-limits"] });
		queryClient.invalidateQueries({ queryKey: ["agents-overview"] });
		setEdits({});
	};
	return { saved: saved.data, text, problem, dirty, save, set: (key: Key, value: string) => setEdits((cur) => ({ ...cur, [key]: value })) };
}

export function LimitsTab({ draft }: { draft: ReturnType<typeof useAgentLimitsDraft> }) {
	return (
		<>
			<div className="pg-tab-intro">
				What the agent, auto-draft and MCP clients may do on their own. Agents can't change these. Saved to your deployment.
			</div>
			{FIELDS.map(({ key, title, sub, unit }) => {
				const error = draft.problem(key);
				const { min, max } = AGENT_LIMIT_RANGES[key];
				return (
					<div key={key} className="pg-setting">
						<div className="pg-setting-text">
							<b>{title}</b>
							<span>{sub} Default {DEFAULT_AGENT_LIMITS[key]}.</span>
							{error && <span className="pg-limit-error" role="alert">{error}</span>}
						</div>
						<label className="pg-limit-field">
							<input
								className="pg-input"
								type="number"
								inputMode="numeric"
								min={min}
								max={max}
								step={1}
								value={draft.text(key)}
								aria-label={title}
								aria-invalid={!!error || undefined}
								onChange={(e) => draft.set(key, e.target.value)}
							/>
							<span>{unit}</span>
						</label>
					</div>
				);
			})}
			<section className="pg-settings-section" aria-labelledby="ceilings-heading">
				<h3 id="ceilings-heading">Fixed for everyone</h3>
				<p className="pg-label-note pg-ceilings">
					Each address sends at most {SEND_LIMITS.hour} messages an hour and {SEND_LIMITS.day} a day, people and agents together, with up to {SEND_LIMITS.recipients} recipients per message. Agent limits sit inside these.
				</p>
			</section>
		</>
	);
}
