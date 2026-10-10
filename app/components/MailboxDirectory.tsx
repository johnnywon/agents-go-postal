import {
	CaretDownIcon,
	CaretRightIcon,
	MagnifyingGlassIcon,
	PushPinIcon,
	XIcon,
} from "@phosphor-icons/react";
import {
	type KeyboardEvent,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { Link, useNavigate } from "react-router";
import { useDirectoryPrefs } from "~/hooks/useDirectoryPrefs";
import {
	buildDirectory,
	type DirRow,
	FILTER_MIN,
	type MailboxLike,
} from "~/lib/mailbox-groups";
import { useMailboxes } from "~/queries/mailboxes";

const NO_MAILBOXES: MailboxLike[] = [];
const HANDLED_KEYS = new Set(["ArrowDown", "ArrowUp", "Home", "End", "Enter", "Escape"]);

const noun = (count: number) => (count === 1 ? " mailbox" : " mailboxes");

const mailboxUrl = (id: string) => `/mailbox/${encodeURIComponent(id)}/emails/inbox`;

// Collapsed groups stay in the DOM with [hidden], so skip anything inside one.
function visibleItems(root: HTMLElement): HTMLElement[] {
	return [...root.querySelectorAll<HTMLElement>("[data-dir-item]")].filter((el) => !el.closest("[hidden]"));
}

function DirectoryRow({
	row,
	showDomain,
	active,
	editing,
	pinned,
	onNavigate,
	onTogglePin,
}: {
	row: DirRow;
	showDomain: boolean;
	active: boolean;
	editing: boolean;
	pinned: boolean;
	onNavigate?: () => void;
	onTogglePin: (row: DirRow, button: HTMLElement) => void;
}) {
	return (
		<li className="dir-item">
			<Link
				to={mailboxUrl(row.id)}
				className="dir-row"
				data-dir-item
				data-active={active}
				// Both copies of a pinned active mailbox lead to the same place, so both are current.
				aria-current={active ? "true" : undefined}
				title={row.email}
				onClick={onNavigate}
			>
				<span>{row.local}</span>
				{showDomain ? (
					<i>
						<span className="sr-only"> at </span>
						{row.domain}
					</i>
				) : (
					<span className="sr-only"> at {row.domain}</span>
				)}
			</Link>
			{editing && (
				<button
					type="button"
					className="dir-pin"
					aria-pressed={pinned}
					aria-label={`Pin ${row.email}`}
					data-pin-for={row.id}
					onClick={(event) => onTogglePin(row, event.currentTarget)}
				>
					<PushPinIcon size={14} weight={pinned ? "fill" : "regular"} aria-hidden="true" />
				</button>
			)}
		</li>
	);
}

export default function MailboxDirectory({
	variant,
	activeId,
	onNavigate,
	skipTo,
}: {
	variant: "sidebar" | "sheet";
	activeId?: string;
	onNavigate?: () => void;
	skipTo?: string;
}) {
	const { data, isPending, isError, refetch } = useMailboxes();
	const { prefs, togglePin, setOpen } = useDirectoryPrefs();
	const navigate = useNavigate();
	const uid = useId();
	const filterId = `${uid}-filter`;
	const rootRef = useRef<HTMLDivElement>(null);
	const filterRef = useRef<HTMLInputElement>(null);
	const pinToggleRef = useRef<HTMLButtonElement>(null);
	const announceTimer = useRef(0);
	const [query, setQuery] = useState("");
	const [editing, setEditing] = useState(false);
	const [announce, setAnnounce] = useState("");

	const loaded = Array.isArray(data);
	const mailboxes = loaded ? data : NO_MAILBOXES;
	const showFilter = mailboxes.length >= FILTER_MIN;
	const model = useMemo(
		() =>
			buildDirectory({
				mailboxes,
				pinned: prefs.pinned,
				open: prefs.open,
				// If the list shrinks below FILTER_MIN the field disappears, so its text must stop filtering.
				query: showFilter ? query : "",
				activeId,
			}),
		[mailboxes, prefs.pinned, prefs.open, query, showFilter, activeId],
	);
	const { total, shown, filtering, pinned, groups } = model;
	const pinnedIds = useMemo(() => new Set(prefs.pinned), [prefs.pinned]);
	const activeKey = activeId?.toLowerCase();
	// The sheet's title is the h2, so the directory nests one level under it.
	const Caption = variant === "sheet" ? "h3" : "h2";
	const GroupHead = variant === "sheet" ? "h4" : "h3";

	// The debounced announcement reads the model as it is when the timer fires.
	const latest = useRef(model);
	useEffect(() => {
		latest.current = model;
	});
	useEffect(() => () => window.clearTimeout(announceTimer.current), []);

	function say(message: string) {
		window.clearTimeout(announceTimer.current);
		setAnnounce(message);
	}

	// Announcements come only from what the user did: typing a filter or changing a pin.
	function changeQuery(next: string) {
		setQuery(next);
		window.clearTimeout(announceTimer.current);
		announceTimer.current = window.setTimeout(() => {
			const { filtering: active, shown: count } = latest.current;
			setAnnounce(!active ? "" : count === 0 ? "No mailboxes match" : `${count} ${count === 1 ? "mailbox" : "mailboxes"}`);
		}, 300);
	}

	function pin(row: DirRow, button: HTMLElement) {
		// A row in the Pinned group is always pinned, so this click unpins it and the row unmounts.
		// Hand focus to its twin first: if focus is lost to the body, Base UI restores it to the dialog instead.
		if (button.closest("[data-dir-pinned]")) {
			const twin = [...(rootRef.current?.querySelectorAll<HTMLElement>("[data-pin-for]") ?? [])].find(
				(el) => el.dataset.pinFor === row.id && !el.closest("[hidden], [data-dir-pinned]"),
			);
			(twin ?? pinToggleRef.current)?.focus();
		}
		const nowPinned = togglePin(row.id);
		say(`${nowPinned ? "Pinned" : "Unpinned"} ${row.email}`);
	}

	function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
		if (!HANDLED_KEYS.has(event.key) || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
		const target = event.target as HTMLElement;
		const items = visibleItems(event.currentTarget);

		if (target.matches("[data-dir-filter]")) {
			if (event.key === "ArrowDown" && !event.nativeEvent.isComposing) {
				event.preventDefault();
				items[0]?.focus();
			} else if (event.key === "Enter" && !event.nativeEvent.isComposing && model.firstMatch) {
				event.preventDefault();
				navigate(mailboxUrl(model.firstMatch.id));
				onNavigate?.();
			} else if (event.key === "Escape" && variant === "sidebar" && query) {
				event.preventDefault();
				changeQuery("");
			}
			return;
		}

		if (!target.matches("[data-dir-item]")) return;
		const index = items.indexOf(target);
		let next: HTMLElement | null | undefined;
		if (event.key === "ArrowDown") next = items[index + 1];
		else if (event.key === "ArrowUp") next = index > 0 ? items[index - 1] : filterRef.current;
		else if (event.key === "Home") next = items[0];
		else if (event.key === "End") next = items[items.length - 1];
		else return;
		event.preventDefault();
		next?.focus();
	}

	function clearFilter() {
		changeQuery("");
		filterRef.current?.focus();
	}

	function rowProps(row: DirRow, copy: "pinned" | "group") {
		return {
			row,
			showDomain: copy === "pinned",
			active: row.id.toLowerCase() === activeKey,
			editing,
			pinned: pinnedIds.has(row.id.toLowerCase()),
			onNavigate,
			onTogglePin: pin,
		};
	}

	return (
		<div className="dir" ref={rootRef} onKeyDown={onKeyDown}>
			{skipTo && (
				<a
					href={`#${skipTo}`}
					className="sr-only focus:not-sr-only dir-skip"
					onClick={(event) => {
						event.preventDefault();
						document.getElementById(skipTo)?.focus();
					}}
				>
					Skip mailbox list
				</a>
			)}
			<div className="sidebar-caption dir-caption">
				<Caption>
					Mailboxes{" "}
					{loaded && <span>{shown === total ? total : `${shown} of ${total}`}</span>}
				</Caption>
				{total > 1 && (
					<button
						type="button"
						ref={pinToggleRef}
						aria-label={editing ? "Done pinning" : "Pin mailboxes"}
						onClick={() => setEditing(!editing)}
					>
						{editing ? "Done" : <PushPinIcon size={14} aria-hidden="true" />}
					</button>
				)}
			</div>
			{!prefs.persistent && editing && (
				<p className="dir-note" role="note">
					Pins are not saved in this browser.
				</p>
			)}
			{showFilter && (
				<div className="dir-filter">
					<MagnifyingGlassIcon size={14} aria-hidden="true" />
					<label className="sr-only" htmlFor={filterId}>
						Filter mailboxes
					</label>
					<input
						ref={filterRef}
						id={filterId}
						data-dir-filter
						type="text"
						inputMode="search"
						enterKeyHint="go"
						autoComplete="off"
						autoCapitalize="off"
						spellCheck={false}
						placeholder="Filter mailboxes"
						value={query}
						onChange={(event) => changeQuery(event.target.value)}
					/>
					{query && (
						<button type="button" aria-label="Clear filter" onClick={clearFilter}>
							<XIcon size={12} aria-hidden="true" />
						</button>
					)}
				</div>
			)}
			<nav className="dir-scroll" aria-label="Mailbox directory">
				{pinned.length > 0 && (
					<section className="dir-group" data-dir-pinned>
						<GroupHead className="dir-group-head">
							<span>
								<PushPinIcon size={12} weight="fill" aria-hidden="true" />
								Pinned <b>{pinned.length}</b>
								<span className="sr-only">{noun(pinned.length)}</span>
							</span>
						</GroupHead>
						<ul className="dir-list">
							{pinned.map((row) => (
								<DirectoryRow key={row.id} {...rowProps(row, "pinned")} />
							))}
						</ul>
					</section>
				)}
				{groups.map((group, index) => {
					const listId = `${uid}-g${index}`;
					const count = group.rows.length;
					const hereHidden = !group.open && group.hasActive;
					return (
						<section className="dir-group" key={group.domain}>
							<GroupHead className="dir-group-head">
								{filtering ? (
									<span>
										{group.domain} <b>{count}</b>
										<span className="sr-only">{noun(count)}</span>
									</span>
								) : (
									<button
										type="button"
										data-dir-item
										aria-expanded={group.open}
										aria-controls={listId}
										onClick={() => setOpen(group.domain, !group.open)}
									>
										{group.open ? (
											<CaretDownIcon size={12} aria-hidden="true" />
										) : (
											<CaretRightIcon size={12} aria-hidden="true" />
										)}
										{group.domain}{" "}
										{hereHidden && <i className="dir-here" aria-hidden="true" />}
										<b>{count}</b>
										<span className="sr-only">{noun(count)}</span>
										{hereHidden && <span className="sr-only">, contains current mailbox</span>}
									</button>
								)}
							</GroupHead>
							<ul id={listId} className="dir-list" hidden={!group.open}>
								{group.rows.map((row) => (
									<DirectoryRow key={row.id} {...rowProps(row, "group")} />
								))}
							</ul>
						</section>
					);
				})}
				{isPending && (
					<p className="dir-empty" role="status">
						Loading mailboxes
					</p>
				)}
				{isError && (
					<div className="dir-empty" role={mailboxes.length ? undefined : "alert"}>
						Could not load mailboxes
						<button type="button" className="deck-button" onClick={() => refetch()}>
							Try again
						</button>
					</div>
				)}
				{filtering && shown === 0 && (
					<div className="dir-empty">
						No mailboxes match
						<button type="button" className="deck-button" onClick={clearFilter}>
							Clear filter
						</button>
					</div>
				)}
			</nav>
			<p className="sr-only" role="status" aria-live="polite">
				{announce}
			</p>
		</div>
	);
}
