/**
 * Figures: how the product shows a count, a size or a length of time in a small space.
 *
 * Every figure is a number of at most six characters and a unit in caps, singular or plural
 * with the value ("1 EMAIL", "12,408 EMAILS"). The unit steps up before the number gets long, so
 * a figure always fits its cell. null means unknown: the caller shows "—" and keeps the unit.
 * DESIGN.md (Figures) has the rules; the console colophon is the first user.
 */

export interface Figure {
	/** The number as shown, six characters at most. */
	fig: string;
	/** The unit in caps, singular when the value is 1. */
	unit: string;
}

const known = (n: number | null | undefined): n is number => n != null && Number.isFinite(n) && n >= 0;
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
/** One decimal under 10 ("3.2"), none from 10 ("40"), dropping a trailing ".0". */
const short = (n: number) => (n < 10 ? String(Math.floor(n * 10) / 10) : String(Math.floor(n)));

/** A count of things: 12,408 up to 99,999, then 248k, then 2.4M. */
export function countFigure(n: number | null | undefined, one: string, many: string): Figure | null {
	if (!known(n)) return null;
	const v = Math.round(n);
	if (v < 1e5) return { fig: v.toLocaleString("en-US"), unit: plural(v, one, many) };
	if (v < 1e6) return { fig: `${Math.floor(v / 1e3)}k`, unit: many };
	return { fig: `${short(v / 1e6)}M`, unit: many };
}

/** Bytes in decimal units: 412 MB, 1.39 GB, 48.6 GB, 1.28 TB. Under 1 MB shows KB. */
export function bytesFigure(b: number | null | undefined): Figure | null {
	if (!known(b)) return null;
	if (b < 1e6) return { fig: String(Math.round(b / 1e3)), unit: "KB" };
	if (b < 1e9) return { fig: String(Math.round(b / 1e6)), unit: "MB" };
	const gb = b / 1e9;
	if (gb < 1000) return { fig: gb.toFixed(gb < 10 ? 2 : gb < 100 ? 1 : 0), unit: "GB" };
	return { fig: (gb / 1000).toFixed(2), unit: "TB" };
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/**
 * A length of time, in the largest unit that still reads as a number you can picture:
 * minutes under an hour, hours under two days, days under two weeks, then weeks.
 * 45 MINS, 3 HRS, 47 HRS, 2 DAYS, 3.2 DAYS, 13 DAYS, 2 WKS, 5.7 WKS, 52 WKS, 104 WKS.
 * Rounds down, so the figure never claims more time than has passed.
 */
export function durationFigure(seconds: number | null | undefined): Figure | null {
	if (!known(seconds)) return null;
	if (seconds < HOUR) {
		const m = Math.floor(seconds / MINUTE);
		return { fig: String(m), unit: plural(m, "MIN", "MINS") };
	}
	if (seconds < 2 * DAY) {
		const h = Math.floor(seconds / HOUR);
		return { fig: String(h), unit: plural(h, "HR", "HRS") };
	}
	if (seconds < 2 * WEEK) {
		const d = short(seconds / DAY);
		return { fig: d, unit: d === "1" ? "DAY" : "DAYS" };
	}
	const w = short(seconds / WEEK);
	return { fig: w, unit: w === "1" ? "WK" : "WKS" };
}

/** Seconds since an ISO time, or null when there is no time to count from. */
export function secondsSince(iso: string | null | undefined, now = Date.now()): number | null {
	const t = iso ? Date.parse(iso) : NaN;
	return Number.isFinite(t) ? Math.max(0, (now - t) / 1000) : null;
}

/** What a screen reader hears for a figure: "Storage: 1.39 gb", or "Storage: unavailable". */
export function figureLabel(label: string, f: Figure | null): string {
	return f ? `${label}: ${f.fig} ${f.unit.toLowerCase()}` : `${label}: unavailable`;
}
