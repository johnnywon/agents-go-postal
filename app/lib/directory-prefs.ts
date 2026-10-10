export const PREFS_KEY = "agp.directory.v1";

// Snapshots are replaced, never edited: useSyncExternalStore compares them by identity.
export type Prefs = { pinned: string[]; open: Record<string, boolean>; persistent: boolean };

type Stored = Pick<Prefs, "pinned" | "open">;

// Frozen because the Worker shares this one object across every server render.
const SERVER_SNAPSHOT: Prefs = { pinned: [], open: {}, persistent: true };
Object.freeze(SERVER_SNAPSHOT.pinned);
Object.freeze(SERVER_SNAPSHOT.open);
Object.freeze(SERVER_SNAPSHOT);

function normalizePins(ids: string[]): string[] {
	return [...new Set(ids.map((id) => id.toLowerCase()).filter(Boolean))];
}

function normalizeOpen(open: object): Record<string, boolean> {
	const entries: [string, boolean][] = [];
	for (const [domain, value] of Object.entries(open)) {
		if (domain && typeof value === "boolean") entries.push([domain.toLowerCase(), value]);
	}
	// fromEntries defines own properties, so a stored "__proto__" key cannot swap the prototype.
	return Object.fromEntries(entries);
}

function parse(raw: string): Stored | null {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!value || typeof value !== "object") return null;
	const { v, pinned, open } = value as Record<string, unknown>;
	if (v !== 1) return null;
	if (!Array.isArray(pinned) || !pinned.every((id) => typeof id === "string")) return null;
	if (!open || typeof open !== "object" || Array.isArray(open)) return null;
	return { pinned: normalizePins(pinned), open: normalizeOpen(open) };
}

function same(a: Prefs, b: Prefs): boolean {
	if (a.persistent !== b.persistent || a.pinned.length !== b.pinned.length) return false;
	if (a.pinned.some((id, i) => id !== b.pinned[i])) return false;
	const keys = Object.keys(a.open);
	return keys.length === Object.keys(b.open).length && keys.every((key) => a.open[key] === b.open[key]);
}

export function createPrefsStore(getStorage: () => Storage | null) {
	let current: Prefs | null = null;
	let attached = false;
	const listeners = new Set<() => void>();

	function emit() {
		for (const listener of [...listeners]) listener();
	}

	// null means storage could not be read at all; an empty or corrupt entry reads as defaults.
	function read(): Stored | null {
		let raw: string | null;
		try {
			const storage = getStorage();
			if (!storage) return null;
			raw = storage.getItem(PREFS_KEY);
		} catch {
			return null;
		}
		return (raw && parse(raw)) || { pinned: [], open: {} };
	}

	function write(pinned: string[], open: Record<string, boolean>): boolean {
		try {
			const storage = getStorage();
			if (!storage) return false;
			storage.setItem(PREFS_KEY, JSON.stringify({ v: 1, pinned, open }));
			return true;
		} catch {
			return false;
		}
	}

	function load(): Prefs {
		const stored = read();
		// When storage is unreadable the session keeps what it already has.
		const next: Prefs = stored
			? { pinned: stored.pinned, open: stored.open, persistent: true }
			: { pinned: current ? current.pinned : [], open: current ? current.open : {}, persistent: false };
		if (!current) {
			current = next;
		} else if (!same(current, next)) {
			current = next;
			emit();
		}
		return current;
	}

	function ensure(): Prefs {
		return current || load();
	}

	function commit(pinned: string[], open: Record<string, boolean>) {
		current = { pinned, open, persistent: write(pinned, open) };
		emit();
	}

	function onStorage(event: StorageEvent) {
		if (event.key && event.key !== PREFS_KEY) return;
		load();
	}

	return {
		getSnapshot: (): Prefs => ensure(),
		getServerSnapshot: (): Prefs => SERVER_SNAPSHOT,
		subscribe(fn: () => void): () => void {
			// A fresh wrapper per call, so subscribing the same function twice stays two subscriptions.
			const listener = () => fn();
			listeners.add(listener);
			if (!attached && typeof window !== "undefined") {
				window.addEventListener("storage", onStorage);
				attached = true;
			}
			return () => {
				if (!listeners.delete(listener)) return;
				if (listeners.size === 0 && attached) {
					window.removeEventListener("storage", onStorage);
					attached = false;
				}
			};
		},
		togglePin(id: string): boolean {
			const key = id.toLowerCase();
			const prefs = ensure();
			if (!key) return false;
			const wasPinned = prefs.pinned.includes(key);
			commit(wasPinned ? prefs.pinned.filter((pin) => pin !== key) : [...prefs.pinned, key], prefs.open);
			return !wasPinned;
		},
		setOpen(domain: string, open: boolean): void {
			const key = domain.toLowerCase();
			const prefs = ensure();
			if (!key || prefs.open[key] === open) return;
			commit(prefs.pinned, { ...prefs.open, [key]: open });
		},
		reload(): void {
			load();
		},
	};
}

export const directoryPrefs = createPrefsStore(() => {
	try {
		return window.localStorage;
	} catch {
		return null;
	}
});
