import { useSyncExternalStore } from "react";
import { directoryPrefs } from "~/lib/directory-prefs";

// The server snapshot is one constant object, so hydration matches under ssr: true.
export function useDirectoryPrefs() {
	const prefs = useSyncExternalStore(directoryPrefs.subscribe, directoryPrefs.getSnapshot, directoryPrefs.getServerSnapshot);
	return { prefs, togglePin: directoryPrefs.togglePin, setOpen: directoryPrefs.setOpen };
}
