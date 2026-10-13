// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

// The Alex profile's clock. Every message has a fixed wall-clock time in New
// York, written against the story's own "now": Sunday, October 11, 2026 at
// 8:02 pm. To stay recent, the whole story moves forward in whole weeks, so
// weekdays and times of day never change: the incident stays between 11:37 pm
// and 2:40 am, and league rounds stay on Sundays. Out of football season
// (February to August) it moves in 52-week steps instead, to last autumn.

export const ZONE = "America/New_York";
/** The story's "now", New York time. */
export const STORY_NOW = "2026-10-11T20:02";

const DAY = 86_400_000;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const PARTS = new Intl.DateTimeFormat("en-US", {
	timeZone: ZONE, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short",
});

const ZONE_NAME = new Intl.DateTimeFormat("en-US", { timeZone: ZONE, timeZoneName: "short" });

interface Parts { y: number; mo: number; d: number; h: number; mi: number; wd: number }

/** Wall-clock parts in New York. */
export function zoned(ms: number): Parts {
	const p = Object.fromEntries(PARTS.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
	return { y: +p.year, mo: +p.month - 1, d: +p.day, h: +p.hour % 24, mi: +p.minute, wd: WEEKDAYS.indexOf(p.weekday) };
}

/** A New York wall-clock time as epoch ms. Month is 0-based; the day may overflow. */
function fromZoned(y: number, mo: number, d: number, h: number, mi: number): number {
	const naive = Date.UTC(y, mo, d, h, mi);
	const offset = (ms: number) => {
		const p = zoned(ms);
		return Date.UTC(p.y, p.mo, p.d, p.h, p.mi) - Math.floor(ms / 60_000) * 60_000;
	};
	const guess = naive - offset(naive);
	return naive - offset(guess);
}

function parseLocal(local: string): [number, number, number, number, number] {
	const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(local);
	if (!m) throw new Error(`bad story time ${local}`);
	return [+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0)];
}

export class StoryClock {
	/** Days the story moved from its written dates. A multiple of seven. */
	readonly shiftDays: number;
	/** The story's "now" after the move. Never later than the real now. */
	readonly now: number;

	constructor(realNow: number) {
		const at = (days: number) => this.place(STORY_NOW, days);
		const steps = (size: number) => {
			let n = Math.floor((realNow - at(0)) / (size * DAY));
			while (at(n * size) > realNow) n--;
			while (at((n + 1) * size) <= realNow) n++;
			return n * size;
		};
		let days = steps(7);
		const month = zoned(at(days)).mo;
		if (month >= 1 && month <= 7) days = steps(364);
		this.shiftDays = days;
		this.now = at(days);
	}

	private place(local: string, days: number): number {
		const [y, mo, d, h, mi] = parseLocal(local);
		return fromZoned(y, mo, d + days, h, mi);
	}

	/** A written story time ("2026-10-08T23:37" or a date), moved with the story. */
	at(local: string): number {
		return this.place(local, this.shiftDays);
	}

	/** "October 9" */
	day(local: string | number): string {
		const p = zoned(typeof local === "number" ? local : this.at(local));
		return `${MONTHS[p.mo]} ${p.d}`;
	}

	/** "October 9, 2026" */
	date(local: string | number): string {
		const p = zoned(typeof local === "number" ? local : this.at(local));
		return `${MONTHS[p.mo]} ${p.d}, ${p.y}`;
	}

	/** "Oct 9" */
	short(local: string | number): string {
		return this.day(local).replace(/^(\w{3})\w*/, "$1");
	}

	/** "2026-10-09", for files. */
	iso(local: string | number): string {
		const p = zoned(typeof local === "number" ? local : this.at(local));
		return `${p.y}-${String(p.mo + 1).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
	}

	/** "2026-10-09T04:09:00Z" */
	utc(local: string): string {
		return new Date(this.at(local)).toISOString().replace(/\.\d{3}Z$/, "Z");
	}

	/** The year a story date falls in after the move. */
	year(local: string): number {
		return zoned(this.at(local)).y;
	}

	/** "11:37 PM" */
	time(ms: number): string {
		const p = zoned(ms);
		return `${p.h % 12 || 12}:${String(p.mi).padStart(2, "0")} ${p.h < 12 ? "AM" : "PM"}`;
	}

	/** "EDT" or "EST". */
	zone(ms: number): string {
		return ZONE_NAME.formatToParts(new Date(ms)).find((x) => x.type === "timeZoneName")?.value ?? "ET";
	}

	/** "Thu, Oct 8, 2026 at 11:37 PM", as a reply quotes it. */
	long(ms: number): string {
		const p = zoned(ms);
		return `${WEEKDAYS[p.wd]}, ${MONTHS[p.mo].slice(0, 3)} ${p.d}, ${p.y} at ${this.time(ms)}`;
	}
}
