// Whether the page layout is mid-motion (a side column opening or closing).
// Kept outside React so marking it costs no render. Work that would relayout
// on every frame of the motion, like an email frame reporting its height,
// waits for `onLayoutSettled` instead.

let until = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

/** Mark the layout as moving for `ms` from now. Calls during a motion extend it. */
export function markLayoutMoving(ms: number): void {
	until = Math.max(until, performance.now() + ms);
	clearTimeout(timer);
	timer = setTimeout(() => {
		until = 0;
		for (const fn of [...listeners]) fn();
	}, until - performance.now());
}

export function layoutMoving(): boolean {
	return until > performance.now();
}

/** Run `fn` each time a motion ends. Returns the unsubscribe. */
export function onLayoutSettled(fn: () => void): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}
