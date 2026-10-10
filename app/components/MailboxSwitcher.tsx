import { Dialog } from "@cloudflare/kumo";
import { CaretDownIcon, EnvelopeSimpleIcon, TrayIcon, XIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import MailboxDirectory from "~/components/MailboxDirectory";
import { useMailboxes } from "~/queries/mailboxes";

// Same split as the directory: everything after the last "@" is the domain.
function splitAddress(address: string): { local: string; domain: string } {
	const at = address.lastIndexOf("@");
	if (at < 1 || at === address.length - 1) return { local: address, domain: "" };
	return { local: address.slice(0, at), domain: address.slice(at + 1) };
}

export default function MailboxSwitcher({
	variant,
	activeId,
	onNavigate,
}: {
	variant: "home" | "mailbox";
	activeId?: string;
	onNavigate?: () => void;
}) {
	const [open, setOpen] = useState(false);
	const headRef = useRef<HTMLDivElement>(null);
	const { data } = useMailboxes();

	// The inline directory takes over above 1000px, so an open sheet has nothing to return to.
	useEffect(() => {
		if (variant !== "home") return;
		// Complements the inline sidebar's (max-width: 1000px), so fractional widths never show both.
		const wide = window.matchMedia("(width > 1000px)");
		const close = () => {
			if (wide.matches) setOpen(false);
		};
		wide.addEventListener("change", close);
		return () => wide.removeEventListener("change", close);
	}, [variant]);

	// Base UI focuses the first control (Close). Move focus after it has done so.
	// A touch screen keeps the keyboard closed by landing on a row instead of the filter.
	// Centering sets scrollTop on the list itself: scrollIntoView would also scroll the sheet and the page.
	useEffect(() => {
		if (!open) return;
		let second = 0;
		const first = requestAnimationFrame(() => {
			second = requestAnimationFrame(() => {
				const popup = headRef.current?.parentElement;
				if (!popup) return;
				const visible = (selector: string) =>
					[...popup.querySelectorAll<HTMLElement>(selector)].find((el) => !el.closest("[hidden]"));
				const filter = visible("[data-dir-filter]");
				const current = visible('[data-dir-item][aria-current="true"]');
				const target = filter && window.matchMedia("(pointer: fine)").matches ? filter : (current ?? visible("[data-dir-item]"));
				target?.focus({ preventScroll: true });
				const scroller = popup.querySelector<HTMLElement>(".dir-scroll");
				const centered = current ?? target;
				if (scroller && centered && scroller.contains(centered)) {
					const box = scroller.getBoundingClientRect();
					const row = centered.getBoundingClientRect();
					scroller.scrollTop += row.top - box.top - (box.height - row.height) / 2;
				}
			});
		});
		return () => {
			cancelAnimationFrame(first);
			cancelAnimationFrame(second);
		};
	}, [open]);

	const mailboxes = Array.isArray(data) ? data : [];
	const email = activeId ? (mailboxes.find((m) => m?.id?.toLowerCase() === activeId.toLowerCase())?.email || activeId) : "";
	const { local, domain } = splitAddress(email);

	return (
		<>
			{variant === "home" ? (
				<button type="button" className="deck-button mailbox-switch" aria-haspopup="dialog" onClick={() => setOpen(true)}>
					<EnvelopeSimpleIcon size={17} aria-hidden="true" />
					<span>Mailboxes</span>
					<CaretDownIcon size={12} aria-hidden="true" />
				</button>
			) : (
				<div className="border-b border-kumo-line px-2 py-1">
					<button
						type="button"
						className="deck-button mailbox-switch"
						aria-haspopup="dialog"
						aria-label={`${local || "Mailboxes"}${domain ? ` ${domain}` : ""}, switch mailbox`}
						title={email || undefined}
						onClick={() => setOpen(true)}
					>
						<EnvelopeSimpleIcon size={17} aria-hidden="true" />
						<span>
							<strong>{local || "Mailboxes"}</strong>
							{domain && <small>{domain}</small>}
						</span>
						<CaretDownIcon size={12} aria-hidden="true" />
					</button>
				</div>
			)}
			<Dialog.Root open={open} onOpenChange={setOpen}>
				{/* Kumo fixes the transition to scale and opacity. The sheet slides, so it also needs translate. */}
				<Dialog size="sm" className="dir-sheet" style={{ transitionProperty: "translate, opacity" }}>
					<div className="dir-sheet-head" ref={headRef}>
						<Dialog.Title>Switch mailbox</Dialog.Title>
						<Dialog.Close
							render={(props) => (
								<button {...props} type="button" className="deck-button icon-button" aria-label="Close mailboxes">
									<XIcon size={16} aria-hidden="true" />
								</button>
							)}
						/>
					</div>
					<div className="dir-all">
						<Link
							to="/"
							className="dir-row"
							data-active={!activeId}
							aria-current={activeId ? undefined : "page"}
							onClick={() => {
								setOpen(false);
								onNavigate?.();
							}}
						>
							<TrayIcon size={14} aria-hidden="true" />
							<span>All inboxes</span>
						</Link>
					</div>
					<MailboxDirectory
						variant="sheet"
						activeId={activeId}
						onNavigate={() => {
							setOpen(false);
							onNavigate?.();
						}}
					/>
				</Dialog>
			</Dialog.Root>
		</>
	);
}
