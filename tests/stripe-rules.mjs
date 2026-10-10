// Finds edge-accent stripes in source text. Used by tests/design-rules.test.mjs, which enforces the
// "No accent stripes or edge bars" rule in DESIGN.md.
//
// TypeScript and JavaScript are parsed with the TypeScript compiler, so class lists, style objects, DOM
// assignments and CSS held in strings are read from the syntax tree after ternaries, template literals,
// constants and cn()/clsx() calls are resolved. CSS and every other file type go through a small tolerant
// CSS scanner. Both feed the same rules, grouped below by technique: borders, shadows, gradients and
// background sizes, drawn bars (pseudo-elements and thin elements), Tailwind classes, Kumo components and
// quoted-reply bars. A rule works on what a value means (units converted, colours classified, shadow
// layers split), not on how it is spelled.
//
// analyse(path, text, context) returns [{ rule, index, line }]; buildContext(files) reads the custom
// properties (--name: value) that colours and widths can refer to.

import { extname } from "node:path";
import ts from "typescript";

const SCRIPT_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

export const RULES = {
	// borders
	border_side_wide: "a one-sided border 2px or thicker (any unit, order, longhand or logical spelling)",
	border_side_colored: "a one-sided border in a chromatic colour, at any width, or a colour swapped onto one side",
	border_width_split: "border-width gives one side 2px or more and another side less",
	border_color_split: "border-color gives one side a chromatic colour and the others something else",
	border_image: "border-image draws gradient edges",
	underline_bar: "a text underline 2px or thicker in a chromatic colour",
	// shadows
	shadow_bar: "a box-shadow or drop-shadow offset along one axis with a hard edge (or a coloured one with a 1px blur)",
	shadow_hairline: "a 1px coloured one-axis shadow",
	// gradients and background sizes
	gradient_hard_stop: "a linear gradient with a hard stop 2-8px from an edge",
	gradient_accent_fade: "a one-axis fade between an accent colour and transparent",
	bg_size_bar: "a 2-8px background tile stretched along an edge",
	// drawn bars
	pseudo_bar: "a ::before or ::after drawn as a bar: one side 2-8px, the other long or stretched",
	glyph_bar: "a left-block character (▌ ▎ ▏) standing in for a bar",
	element_bar: "a thin coloured element used as a bar (also classes plus inline style on one element)",
	// Tailwind
	tw_border_wide: "Tailwind border-l/r/t/b/s/e/x/y or divide-x/y at 2px or more",
	tw_border_colored: "Tailwind one-sided border colour class in a chromatic colour",
	tw_border_plus_accent: "Tailwind one-sided 1px border together with a chromatic border colour",
	// Kumo
	kumo_collapsible: "Kumo Collapsible draws a left bar",
	kumo_underline_tabs: "Kumo variant=\"underline\" draws an underline bar",
	// quoted replies
	quote_bar: "quoted-reply text with a one-sided left border; use a fill or a full 1px box",
};

// ---------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------

// A value only known at runtime is written §name§, where name is the identifier it came from (`${theme.line}`
// becomes §line§). The name lets a colour be judged: line is neutral, accent is not, anything unknown is not.
const dyn = (name = "") => `§${name.replace(/[^\w-]/g, "")}§`;
const DYN = dyn();
const DYN_TOKEN = /^§[\w-]*§$/;

// camelCase and PascalCase keys become kebab-case; names that already have hyphens are only lower-cased.
function kebab(name) {
	return name.includes("-") ? name.toLowerCase() : name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

// 1-based line of `index`; `starts` is the offset of every line start, found once per file.
function lineStarts(text) {
	const starts = [0];
	for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
	return starts;
}

function lineOf(starts, index) {
	let low = 0;
	let high = starts.length - 1;
	while (low < high) {
		const mid = (low + high + 1) >> 1;
		if (starts[mid] <= index) low = mid;
		else high = mid - 1;
	}
	return low + 1;
}

// Replaces comments by spaces of the same length so offsets and line numbers stay valid. An unterminated
// comment runs to the end of the file only where that is how the language works (CSS).
function blankRanges(text, open, close, toEnd) {
	let out = "";
	let from = 0;
	for (let i = text.indexOf(open); i !== -1; i = text.indexOf(open, from)) {
		const end = text.indexOf(close, i + open.length);
		if (end === -1 && !toEnd) break;
		const stop = end === -1 ? text.length : end + close.length;
		out += text.slice(from, i) + text.slice(i, stop).replace(/[^\n]/g, " ");
		from = stop;
	}
	return out + text.slice(from);
}

function stripComments(text, ext) {
	let out = blankRanges(text, "/*", "*/", ext === ".css");
	if (ext !== ".css") out = blankRanges(out, "<!--", "-->", false);
	if ([".scss", ".sass", ".less", ".styl"].includes(ext)) out = out.replace(/(^|\s)\/\/[^\n]*/g, (m) => m.replace(/[^\s]/g, " "));
	return out;
}

function closeParen(s, open) {
	let depth = 0;
	for (let i = open; i < s.length; i++) {
		if (s[i] === "(") depth++;
		else if (s[i] === ")" && --depth === 0) return i;
	}
	return s.length;
}

function splitTop(s, sep) {
	const out = [];
	let depth = 0;
	let from = 0;
	for (let i = 0; i < s.length; i++) {
		if (s[i] === "(") depth++;
		else if (s[i] === ")") depth = Math.max(0, depth - 1);
		else if (s[i] === sep && depth === 0) {
			out.push(s.slice(from, i));
			from = i + 1;
		}
	}
	out.push(s.slice(from));
	return out;
}

function topTokens(s) {
	const out = [];
	let depth = 0;
	let from = -1;
	for (let i = 0; i <= s.length; i++) {
		const c = s[i];
		if (c === "(") depth++;
		else if (c === ")") depth = Math.max(0, depth - 1);
		const gap = i === s.length || (depth === 0 && /\s/.test(c));
		if (gap) {
			if (from >= 0) out.push(s.slice(from, i));
			from = -1;
		} else if (from < 0) from = i;
	}
	return out;
}

// Relative units are approximated; a stripe is 2px or more by any reasonable reading of them.
const UNIT_PX = { px: 1, rem: 16, em: 16, pt: 4 / 3, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6, ch: 8, ex: 8, lh: 24, rlh: 24, vw: 10, vh: 10, vmin: 10, vmax: 10, svw: 10, svh: 10, lvw: 10, lvh: 10, dvw: 10, dvh: 10 };
const LENGTH_UNITS = Object.keys(UNIT_PX).join("|");

function lengthPx(token) {
	const m = /^([+-]?(?:\d+\.?\d*|\.\d+))([a-z]+)?$/i.exec(token);
	if (!m) return null;
	if (!m[2]) return Number(m[1]) === 0 ? 0 : null;
	const unit = UNIT_PX[m[2].toLowerCase()];
	return unit === undefined ? null : Number(m[1]) * unit;
}

function maxLengthIn(s) {
	let max = -Infinity;
	for (const m of s.matchAll(new RegExp(`(?<![\\w.])[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:${LENGTH_UNITS})\\b`, "gi"))) max = Math.max(max, lengthPx(m[0]));
	return max;
}

// ---------------------------------------------------------------------------------------------------------
// Colours: neutral greys pass, anything with chroma, a brand token or an unknown value is an accent
// ---------------------------------------------------------------------------------------------------------

const NEUTRAL_COLORS = new Set(
	"transparent currentcolor inherit initial unset revert none black white gray grey silver gainsboro whitesmoke lightgray lightgrey darkgray darkgrey dimgray dimgrey slategray slategrey lightslategray lightslategrey darkslategray darkslategrey canvas canvastext buttonface buttontext buttonborder graytext field fieldtext marktext".split(" "),
);
const CHROMATIC_COLORS = new Set(
	"aliceblue antiquewhite aqua aquamarine azure beige bisque blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgreen darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkturquoise darkviolet deeppink deepskyblue dodgerblue firebrick floralwhite forestgreen fuchsia ghostwhite gold goldenrod green greenyellow honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgreen lightpink lightsalmon lightseagreen lightskyblue lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna skyblue slateblue snow springgreen steelblue tan teal thistle tomato turquoise violet wheat yellow yellowgreen accentcolor accentcolortext highlight highlighttext linktext activetext visitedtext selecteditem selecteditemtext mark".split(" "),
);
// Words in a name (a custom property, a Tailwind colour, a runtime value) that mark an accent or a neutral.
// A name with neither is judged by its definition in the scanned files, then by its fallback, then as an accent.
const ACCENT_WORDS = new Set(
	"accent airmail brand primary secondary selected active danger destructive warning info success error red orange amber yellow lime green emerald teal cyan sky blue indigo violet purple fuchsia pink rose crimson".split(" "),
);
const NEUTRAL_WORDS = new Set(
	"line lines border borders divider rule hair hairline gray grey neutral muted metal case ink graphite lcd silver titanium fill tint recessed surface base elevated overlay control contrast chassis edge bevel stroke separator sep shadow highlight input".split(" "),
);
const nameWords = (name) => name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const spreadOf = (channels) => Math.max(...channels) - Math.min(...channels);
const CHROMA_SPREAD = 32; // channel spread above this reads as colour; real neutrals top out near 24

function hex6(hex) {
	const h = hex.toLowerCase();
	return h.length <= 4 ? [...h.slice(0, 3)].map((c) => c + c).join("") : h.slice(0, 6);
}

function hexChromatic(hex, ctx) {
	if (![3, 4, 6, 8].includes(hex.length)) return false;
	const full = hex6(hex);
	if (ctx.brand.has(full)) return true;
	return spreadOf([0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16))) > CHROMA_SPREAD;
}

function functionChromatic(fn, args) {
	const nums = args.split(/[\s,/]+/).filter(Boolean);
	const num = (s) => (s.endsWith("%") ? Number.parseFloat(s) * 2.55 : Number.parseFloat(s));
	if (fn === "rgb" || fn === "rgba") {
		const c = nums.slice(0, 3).map(num);
		return c.length < 3 || c.some(Number.isNaN) || spreadOf(c) > CHROMA_SPREAD;
	}
	if (fn === "hsl" || fn === "hsla") {
		const s = Number.parseFloat(nums[1]) / 100;
		const l = Number.parseFloat(nums[2]) / 100;
		return Number.isNaN(s + l) || (1 - Math.abs(2 * l - 1)) * s * 255 > CHROMA_SPREAD;
	}
	if (fn === "oklch") {
		const c = Number.parseFloat(nums[1]);
		return Number.isNaN(c) || c > 0.04;
	}
	if (fn === "oklab") {
		const chroma = Math.hypot(Number.parseFloat(nums[1]), Number.parseFloat(nums[2]));
		return Number.isNaN(chroma) || chroma > 0.04;
	}
	return true; // lab, lch, hwb, color(): not worth decoding
}

function dynChromatic(name) {
	const words = nameWords(name);
	if (words.some((w) => ACCENT_WORDS.has(w))) return true;
	return !words.some((w) => NEUTRAL_WORDS.has(w));
}

function varChromatic(args, ctx, depth) {
	const comma = args.indexOf(",");
	const name = (comma < 0 ? args : args.slice(0, comma)).trim();
	const fallback = comma < 0 ? "" : args.slice(comma + 1).trim();
	const words = nameWords(name);
	if (words.some((w) => ACCENT_WORDS.has(w))) return true;
	if (words.some((w) => NEUTRAL_WORDS.has(w))) return false;
	const definitions = ctx.vars.get(name);
	if (definitions && depth < 4) return definitions.some((value) => isChromatic(value, ctx, depth + 1));
	return fallback ? isChromatic(fallback, ctx, depth + 1) : true;
}

// True when any colour inside `value` has chroma, is a brand colour, or is only known at runtime.
function isChromatic(value, ctx, depth = 0) {
	const re = /#([0-9a-f]{3,8})\b|(rgba?|hsla?|hwb|oklch|oklab|lab|lch|color-mix|color|var|url)\(|§([\w-]*)§|(?<![\w.#-])([a-z]+)(?![\w.(-])/gi;
	let m;
	while ((m = re.exec(value))) {
		if (m[1] !== undefined) {
			if (hexChromatic(m[1], ctx)) return true;
		} else if (m[2]) {
			const fn = m[2].toLowerCase();
			const close = closeParen(value, re.lastIndex - 1);
			const args = value.slice(re.lastIndex, close);
			re.lastIndex = close + 1;
			if (fn === "url") continue;
			if (fn === "var" ? varChromatic(args, ctx, depth) : fn === "color-mix" ? isChromatic(args, ctx, depth) : functionChromatic(fn, args)) return true;
		} else if (m[3] !== undefined) {
			if (dynChromatic(m[3])) return true;
		} else if (CHROMATIC_COLORS.has(m[4].toLowerCase())) return true;
	}
	return false;
}

const isTransparent = (color) =>
	/^transparent$|^#[0-9a-f]{6}00$|^#[0-9a-f]{3}0$|^(?:rgb|hsl)a?\(.*[,/]\s*0(?:\.0+)?%?\s*\)$/i.test(color.trim());

const isColorToken = (token) =>
	/^#[0-9a-f]{3,8}$/i.test(token) || /^[a-z-]+\(/i.test(token) || NEUTRAL_COLORS.has(token) || CHROMATIC_COLORS.has(token);

// Custom properties and brand colours defined anywhere in the scanned files.
function buildContext(files) {
	const vars = new Map();
	for (const { text } of files) {
		for (const m of text.matchAll(/(--[\w-]+)\s*:\s*([^;}"'`<>]{1,400})/g)) {
			const list = vars.get(m[1]) ?? [];
			list.push(m[2].trim());
			vars.set(m[1], list);
		}
	}
	const brand = new Set();
	for (const [name, values] of vars) {
		if (!nameWords(name).some((w) => ACCENT_WORDS.has(w))) continue;
		for (const value of values) for (const h of value.matchAll(/#([0-9a-f]{3,8})\b/gi)) if ([3, 4, 6, 8].includes(h[1].length)) brand.add(hex6(h[1]));
	}
	return { vars, brand };
}

// ---------------------------------------------------------------------------------------------------------
// Rules: borders
// ---------------------------------------------------------------------------------------------------------

const SIDES = "left|right|top|bottom|inline-start|inline-end|block-start|block-end|inline|block";
const BORDER_SIDE_PROP = new RegExp(`^(?:-webkit-)?border-(?:${SIDES})(-width|-color|-style)?$`);
const BORDER_STYLES = new Set(["dotted", "dashed", "solid", "double", "groove", "ridge", "inset", "outset"]);
const WIDTH_WORDS = { thin: 1, medium: 3, thick: 5 };
const THICK_PX = 1.99; // "2px or thicker", with room for rem rounding

// Widest length a var() can resolve to, through its definition or its fallback.
function varWidth(token, ctx) {
	const inner = token.slice(4, -1);
	const comma = inner.indexOf(",");
	const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
	const sources = [...(ctx.vars.get(name) ?? [])];
	if (comma >= 0) sources.push(inner.slice(comma + 1));
	return Math.max(-Infinity, ...sources.map(maxLengthIn));
}

// `border-left`, `border-inline-start-width` and friends. A value that is not border-shaped (prose in a
// string, say) returns null.
function sideBorderRule(kind, value, ctx) {
	if (kind === "-style") return null;
	if (kind === "-color") return isChromatic(value, ctx) ? "border_side_colored" : null;
	const tokens = topTokens(value.toLowerCase());
	if (tokens.length === 0 || (tokens.length === 1 && DYN_TOKEN.test(tokens[0]))) return null;
	let style = null;
	let width = null;
	let dynamic = false;
	const colors = [];
	for (const token of tokens) {
		if (DYN_TOKEN.test(token)) dynamic = true;
		if (token === "none" || token === "hidden") style = "none";
		else if (BORDER_STYLES.has(token)) style ??= "visible";
		else if (token in WIDTH_WORDS) width = Math.max(width ?? 0, WIDTH_WORDS[token]);
		else if (lengthPx(token) !== null) width = Math.max(width ?? 0, lengthPx(token));
		else if (token.startsWith("calc(") || token.startsWith("var(")) {
			// A var() may stand for the width, the colour or the whole border, so it counts as a colour too.
			const known = token.startsWith("calc(") ? maxLengthIn(token) : varWidth(token, ctx);
			if (known > -Infinity) width = Math.max(width ?? 0, known);
			if (token.startsWith("var(")) colors.push(token);
		} else if (/^§[\w-]*§(?:px|rem|em)$/.test(token)) continue;
		else if (isColorToken(token) || DYN_TOKEN.test(token)) colors.push(token);
		else return null;
	}
	if (style === "none") return null;
	if (kind === "" && style === "visible" && width === null && !dynamic) width = WIDTH_WORDS.medium; // the CSS default
	if (width !== null && width < 0.01) return null;
	if (width !== null && width >= THICK_PX) return "border_side_wide";
	return colors.length > 0 && isChromatic(colors.join(" "), ctx) ? "border_side_colored" : null;
}

// Per-side widths (`0 0 0 3px`), or null when a value is not a width.
function widthsOf(value) {
	const widths = topTokens(value.toLowerCase()).map((t) => WIDTH_WORDS[t] ?? lengthPx(t));
	return widths.length > 0 && widths.every((w) => w !== null) ? widths : null;
}

// border-width: a side of 2px or more next to a thinner one.
function borderWidthSplit(value) {
	const widths = widthsOf(value);
	return widths !== null && widths.length >= 2 && widths.length <= 4 && Math.max(...widths) >= THICK_PX && Math.min(...widths) < THICK_PX;
}

// border-inline-width / border-block-width: one value is both sides, two values may differ.
function axisWidthRule(value) {
	const widths = widthsOf(value);
	if (widths === null || widths.length > 2 || Math.max(...widths) < THICK_PX) return null;
	return Math.min(...widths) < THICK_PX ? "border_width_split" : "border_side_wide";
}

function borderColorSplit(value, ctx) {
	const colors = topTokens(value.toLowerCase());
	return colors.length >= 2 && colors.length <= 4 && new Set(colors).size > 1 && isChromatic(value, ctx);
}

// ---------------------------------------------------------------------------------------------------------
// Rules: shadows
// ---------------------------------------------------------------------------------------------------------

// Splits a shadow list into layers and finds one that is a bar: a single-axis offset with a hard edge.
// Blurred layers stay legal (the real bevel `inset 0 2px 1px #fff` has a 1px blur and a neutral colour).
function shadowRule(list, ctx) {
	for (const layer of splitTop(list, ",")) {
		const lengths = [];
		const rest = [];
		for (const token of topTokens(layer.trim())) {
			if (/^inset$/i.test(token)) continue;
			const px = lengthPx(token);
			if (px !== null && lengths.length < 4) lengths.push(px);
			else rest.push(token);
		}
		if (lengths.length < 2) continue;
		const [x, y, blur = 0] = lengths;
		if ((x !== 0) === (y !== 0)) continue; // not single-axis
		const offset = Math.abs(x || y);
		const chromatic = () => isChromatic(rest.join(" "), ctx);
		if (blur === 0 && offset >= THICK_PX) return "shadow_bar";
		if (blur <= 1 && offset >= THICK_PX && chromatic()) return "shadow_bar";
		if (blur === 0 && offset >= 0.99 && chromatic()) return "shadow_hairline";
	}
	return null;
}

// ---------------------------------------------------------------------------------------------------------
// Rules: gradients and background sizes
// ---------------------------------------------------------------------------------------------------------

function thinEdge(token) {
	const fromEnd = /^calc\(\s*100%\s*-\s*([\d.]+(?:px|rem|em|%))\s*\)$/i.exec(token);
	const edge = fromEnd ? fromEnd[1] : token;
	const px = lengthPx(edge);
	if (px !== null) return px >= THICK_PX && px <= 8;
	const pct = /^([\d.]+)%$/.exec(edge);
	return pct !== null && Number(pct[1]) > 0 && Number(pct[1]) <= 8;
}

function gradientAxis(direction) {
	if (direction === "") return "y";
	const side = /^to\s+(top|bottom|left|right)$/i.exec(direction);
	if (side) return /top|bottom/i.test(side[1]) ? "y" : "x";
	const angle = /^([-+\d.]+)(deg|turn|rad|grad)$/i.exec(direction);
	if (!angle) return null;
	const degrees = Number(angle[1]) * { deg: 1, turn: 360, rad: 180 / Math.PI, grad: 0.9 }[angle[2].toLowerCase()];
	const normal = ((degrees % 360) + 360) % 360;
	if (normal === 0 || normal === 180) return "y";
	return normal === 90 || normal === 270 ? "x" : null;
}

function gradientRules(value, ctx) {
	const rules = new Set();
	for (const m of value.matchAll(/(repeating-)?linear-gradient\(/gi)) {
		const open = m.index + m[0].length - 1;
		const stops = splitTop(value.slice(open + 1, closeParen(value, open)), ",").map((s) => s.trim());
		let direction = "";
		if (/^(?:to\s|[-+\d.]+(?:deg|turn|rad|grad)\b)/i.test(stops[0])) direction = stops.shift().toLowerCase();
		else if (/^var\(\s*--[\w-]*(?:dir|angle|deg)/i.test(stops[0])) {
			stops.shift(); // the direction lives in a custom property, so the axis is unknown
			direction = "var";
		}
		const parsed = stops.map((stop) => {
			const tokens = topTokens(stop);
			return { color: tokens[0] ?? "", positions: tokens.slice(1).map((t) => t.toLowerCase()) };
		});
		const period = m[1] ? lengthPx(parsed.at(-1)?.positions.at(-1) ?? "") : null;
		const texture = m[1] !== undefined && period !== null && period <= 24;
		if (!texture) {
			for (let i = 0; i < parsed.length - 1; i++) {
				const { positions } = parsed[i];
				const hard = positions.length === 2 ? positions[1] : positions.length === 1 && parsed[i + 1].positions[0] === positions[0] ? positions[0] : null;
				if (hard !== null && thinEdge(hard)) {
					rules.add("gradient_hard_stop");
					break;
				}
			}
		}
		if (!m[1] && parsed.length <= 3 && gradientAxis(direction)) {
			const transparent = parsed.some((s) => isTransparent(s.color));
			if (transparent && parsed.some((s) => !isTransparent(s.color) && isChromatic(s.color, ctx))) rules.add("gradient_accent_fade");
		}
	}
	return rules;
}

// `background-size: 3px 100%` or the `/ 3px 100%` part of a background shorthand.
function bgSizeBar(value, shorthand) {
	const thin = (t) => {
		const px = lengthPx(t ?? "");
		return px !== null && px >= THICK_PX && px <= 8;
	};
	const long = (t) => /^(?:100%|[5-9]\d%|calc\(100%.*\))$/i.test(t ?? "") || (lengthPx(t ?? "") ?? 0) >= 40;
	for (const layer of splitTop(value, ",")) {
		let size = layer.trim();
		if (shorthand) {
			const slash = splitTop(layer, "/");
			if (slash.length < 2) continue;
			if (/\brepeat(?:-[xy])?\b/i.test(layer.replace(/no-repeat/gi, ""))) continue; // an explicit repeat is a texture
			size = slash[1];
		}
		const [a, b] = topTokens(size);
		if ((thin(a) && long(b)) || (thin(b) && long(a))) return true;
	}
	return false;
}

// ---------------------------------------------------------------------------------------------------------
// Rules: bars drawn as pseudo-elements or thin elements
// ---------------------------------------------------------------------------------------------------------

// A box is what a rule block, a style object or a class list says about one element: { w, h, position,
// edges:Set, stretchY, stretchX, paint }. A dimension is { px }, { pct }, { auto }, undefined (unset) or null
// (only known at runtime); paint is undefined, "neutral" or "chromatic".
function cssLength(value, ctx) {
	let v = value.trim().toLowerCase();
	const variable = /^var\((--[\w-]+)/.exec(v);
	if (variable) v = (ctx.vars.get(variable[1])?.[0] ?? "").trim().toLowerCase();
	if (v === "auto") return { auto: true };
	const pct = /^([\d.]+)%$/.exec(v);
	if (pct) return { pct: Number(pct[1]) };
	if (/^calc\(\s*100%/.test(v)) return { pct: 100 };
	const px = lengthPx(v);
	return px === null ? null : { px };
}

function paintOf(value, ctx) {
	const v = value.trim().toLowerCase();
	if (!v || /^(?:none|transparent|inherit|initial|unset)$/.test(v)) return undefined;
	return isChromatic(v, ctx) ? "chromatic" : "neutral";
}

// ▌ ▍ ▎ ▏ ▐ ▕ (left and right partial blocks), as a character or as a CSS escape.
const GLYPH_CHARS = "[\\u258c-\\u258f\\u2590\\u2595]";
const GLYPH_BAR = new RegExp(`${GLYPH_CHARS}|\\\\(?:258[c-f]|2590|2595)\\b`, "i");
const GLYPH_ONLY = new RegExp(`^\\s*${GLYPH_CHARS}+\\s*$`);

function boxFromDecls(decls, ctx) {
	const get = (...names) => names.map((n) => decls.get(n)).find((v) => v !== undefined);
	const dim = (...names) => {
		const raw = get(...names);
		return raw === undefined ? undefined : cssLength(raw, ctx);
	};
	const w = dim("width", "inline-size");
	const h = dim("height", "block-size");
	const edges = new Set();
	const set = (names, edge) => names.some((n) => decls.has(n) && !/^auto$/i.test(decls.get(n))) && edges.add(edge);
	set(["left", "inset-inline-start"], "left");
	set(["right", "inset-inline-end"], "right");
	set(["top", "inset-block-start"], "top");
	set(["bottom", "inset-block-end"], "bottom");
	if (decls.has("inset-block")) ["top", "bottom"].forEach((e) => edges.add(e));
	if (decls.has("inset-inline")) ["left", "right"].forEach((e) => edges.add(e));
	if (decls.has("inset")) {
		const t = topTokens(decls.get("inset"));
		const [top, right = top, bottom = top, left = right] = t;
		[["top", top], ["right", right], ["bottom", bottom], ["left", left]].forEach(([edge, v]) => v && v !== "auto" && edges.add(edge));
	}
	const paints = [get("background-color"), get("background"), get("background-image")].filter((v) => v !== undefined).map((v) => paintOf(v.replace(/url\([^)]*\)/gi, ""), ctx));
	return {
		w,
		h,
		position: (decls.get("position") ?? "").toLowerCase(),
		edges,
		stretchY: (edges.has("top") && edges.has("bottom")) || /^stretch$/i.test(decls.get("align-self") ?? "") || /^1\s*\/\s*-1$/.test(decls.get("grid-row") ?? ""),
		stretchX: (edges.has("left") && edges.has("right")) || /^stretch$/i.test(decls.get("justify-self") ?? "") || /^1\s*\/\s*-1$/.test(decls.get("grid-column") ?? ""),
		paint: paints.includes("chromatic") ? "chromatic" : paints.includes("neutral") ? "neutral" : undefined,
	};
}

// The classes and the inline style of one element describe the same box; the inline style wins.
function mergeBoxes(fromClasses, fromStyle) {
	return {
		w: fromStyle.w !== undefined ? fromStyle.w : fromClasses.w,
		h: fromStyle.h !== undefined ? fromStyle.h : fromClasses.h,
		position: fromStyle.position || fromClasses.position,
		edges: new Set([...fromClasses.edges, ...fromStyle.edges]),
		stretchX: fromClasses.stretchX || fromStyle.stretchX,
		stretchY: fromClasses.stretchY || fromStyle.stretchY,
		paint: [fromClasses.paint, fromStyle.paint].includes("chromatic") ? "chromatic" : fromStyle.paint ?? fromClasses.paint,
	};
}

// A thin side (1-8px) paired with a long or stretched side is a bar. Two thin sides are a dot or a 4px
// glyph. A 1px neutral line is a divider. A pseudo-element bar fails in any colour; a plain element only
// when coloured, because a neutral handle or divider is a different thing. A plain element lying flat
// (thin height) counts only when it hugs an edge or spans its parent, so progress fills stay legal.
function barRule(box, pseudo) {
	if (box.paint === undefined) return null;
	const { w, h } = box;
	const thin = (d) => d != null && d.px !== undefined && d.px > 0 && d.px <= 8;
	const unset = (d) => d === undefined || d?.auto === true;
	const long = (d) => d === null || (d !== undefined && ((d.px ?? 0) >= 10 || (d.pct ?? 0) >= 50));
	const anchoredX = box.edges.has("left") || box.edges.has("right");
	const anchoredY = box.edges.has("top") || box.edges.has("bottom");
	const positioned = ["absolute", "fixed", "sticky"].includes(box.position);
	const vertical = thin(w) && !thin(h) && (long(h) || box.stretchY || anchoredX || (unset(h) && !positioned));
	const horizontal = thin(h) && !thin(w) && (anchoredY || box.stretchX || w?.pct >= 100 || (pseudo && (unset(w) || long(w))));
	if (!vertical && !horizontal) return null;
	const thickness = vertical ? w.px : h.px;
	if (box.paint === "neutral" && (thickness < THICK_PX || !pseudo)) return null;
	return pseudo ? "pseudo_bar" : "element_bar";
}

// Rules for one rule block (or style object) taken as a whole: a drawn bar, or a thick underline set by longhands.
function boxRules(decls, pseudo, ctx) {
	const rules = [];
	const bar = barRule(boxFromDecls(decls, ctx), pseudo);
	if (bar) rules.push(bar);
	if (pseudo && GLYPH_BAR.test(decls.get("content") ?? "")) rules.push("glyph_bar");
	const thickness = lengthPx((decls.get("text-decoration-thickness") ?? "").trim());
	if (thickness !== null && thickness >= THICK_PX && isChromatic(decls.get("text-decoration-color") ?? "", ctx)) rules.push("underline_bar");
	return rules;
}

// ---------------------------------------------------------------------------------------------------------
// Declarations: one entry point for CSS text, style objects, DOM assignments and Tailwind arbitrary values
// ---------------------------------------------------------------------------------------------------------

const PX_PROP = /^(?:border(?:-[a-z-]+)?|(?:min-|max-)?(?:width|height|inline-size|block-size)|top|right|bottom|left|inset(?:-[a-z]+)*)$/;
const LITERAL_COLOR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch|color-mix)\(/i;

function checkDecl(prop, rawValue, ctx, emit) {
	let value = rawValue.trim();
	if (/!important$/i.test(value)) value = value.slice(0, -"!important".length).trim();
	if (!value) return;
	if (/gradient\(/i.test(value)) for (const rule of gradientRules(value, ctx)) emit(rule);
	let m;
	if (prop.startsWith("--")) {
		// A custom property holds a shadow when it says so (name, inset) or carries a literal colour next to two lengths.
		const lengths = topTokens(value).filter((t) => lengthPx(t) !== null).length;
		if (lengths >= 2 && (/shadow/i.test(prop) || /\binset\b/i.test(value) || LITERAL_COLOR.test(value))) {
			const rule = shadowRule(value, ctx);
			if (rule) emit(rule);
		}
	} else if ((m = BORDER_SIDE_PROP.exec(prop))) {
		const rule = /^border-(?:inline|block)-width$/.test(prop) ? axisWidthRule(value) : sideBorderRule(m[1] ?? "", value, ctx);
		if (rule) emit(rule);
	} else if (prop === "border-width") {
		if (borderWidthSplit(value)) emit("border_width_split");
	} else if (prop === "border-color") {
		if (borderColorSplit(value, ctx)) emit("border_color_split");
	} else if (/^border-image(?:-source)?$/.test(prop)) {
		if (!/^(?:none|initial|unset|inherit|revert)$/i.test(value) && !DYN_TOKEN.test(value)) emit("border_image");
	} else if (/^(?:-webkit-)?box-shadow$/.test(prop)) {
		const rule = shadowRule(value, ctx);
		if (rule) emit(rule);
	} else if (/^(?:-webkit-)?(?:backdrop-)?filter$/.test(prop)) {
		for (const drop of value.matchAll(/drop-shadow\(/gi)) {
			const rule = shadowRule(value.slice(drop.index + 12, closeParen(value, drop.index + 11)), ctx);
			if (rule) emit(rule);
		}
	} else if (/^(?:-webkit-)?(?:background|mask)-size$/.test(prop)) {
		if (bgSizeBar(value, false)) emit("bg_size_bar");
	} else if (/^(?:-webkit-)?(?:background|mask)$/.test(prop)) {
		if (bgSizeBar(value, true)) emit("bg_size_bar");
	} else if (prop === "text-decoration") {
		const tokens = topTokens(value.toLowerCase());
		if (tokens.some((t) => (lengthPx(t) ?? 0) >= THICK_PX) && isChromatic(value, ctx)) emit("underline_bar");
	}
}

// ---------------------------------------------------------------------------------------------------------
// CSS scanner: css files, CSS inside string literals, and every unknown file type
// ---------------------------------------------------------------------------------------------------------

// A chunk is the text between ; { and }. Returns { prop, value, at } or { apply } or null.
function parseChunk(raw) {
	const t = raw.trimStart();
	if (t.startsWith("@")) {
		const apply = /^@apply\s+([\s\S]*)$/i.exec(t);
		return apply ? { apply: apply[1] } : null;
	}
	const m = /(?:^|[^\w-])(-{0,2}[a-z][\w-]*)["']?\s*:(?!\/\/)/i.exec(raw);
	if (!m) return null;
	let value = raw.slice(m.index + m[0].length).trimStart();
	if (/^["'`]/.test(value)) {
		const end = value.indexOf(value[0], 1);
		value = value.slice(1, end < 0 ? undefined : end);
	} else {
		let depth = 0;
		for (let i = 0; i < value.length; i++) {
			const c = value[i];
			if (c === "(") depth++;
			else if (c === ")") depth = Math.max(0, depth - 1);
			else if (depth === 0 && "\"'`<>".includes(c)) {
				value = value.slice(0, i);
				break;
			}
		}
	}
	// Template placeholders ({{ theme.line }}) are runtime values, named by their last word.
	value = value.replace(/\{+([^{}]*)\}+/g, (placeholder, inner, offset) => (value[offset - 1] === "§" ? "" : dyn(/(\w+)\W*$/.exec(inner)?.[1])));
	return { prop: kebab(m[1]), value: value.trim(), at: m.index + m[0].indexOf(m[1]) };
}

const QUOTE_SELECTOR = /quote/i;
// A chunk that already reads `border-left: 3px solid ` (or `<td style="border-left: 3px solid `) is a
// declaration, so a "{" after it opens a template placeholder ({{color}}), not a rule.
const DECLARATION_START = /^\s*(?:[^{};]*?\bstyle\s*=\s*["'`]\s*)?(?:-webkit-)?(?:border|box-shadow|background|filter|mask|text-decoration|outline)[\w-]*\s*:/i;
const TW_LEFT_BORDER = /^border-[ls](?:-[1-9]\d*|-\[\d.*)?$/;
const LEFT_BORDER_PROP = /^border-(?:left|inline-start)(?:-width)?$/;
// A left border value that draws something: not empty, 0, none, hidden or a reset keyword.
const visibleBorder = (value) => {
	const v = value.trim().toLowerCase();
	return v !== "" && !/\b(?:none|hidden)\b/.test(v) && !/^0(?:px|rem|em)?(?:\s+\w+)?$/.test(v) && !/^(?:initial|unset|inherit|revert)$/.test(v);
};

// <blockquote style="...border-left..."> or <div class="gmail_quote" style="..."> inside a string or markup file.
function htmlQuoteBars(text, report) {
	for (const m of text.matchAll(/<([a-z][\w-]*)\b([^<>]*)>/gi)) {
		if (m[1].toLowerCase() !== "blockquote" && !/\bclass\s*=\s*(["'])[^"']*quote/i.test(m[2])) continue;
		const style = /\bstyle\s*=\s*(["'])([\s\S]*?)\1/i.exec(m[2]);
		if (!style) continue;
		for (const part of style[2].split(";")) {
			const decl = parseChunk(part);
			if (decl?.prop && LEFT_BORDER_PROP.test(decl.prop) && visibleBorder(decl.value)) report("quote_bar", m.index);
		}
	}
}

const SIDE_BORDER_RULES = new Set(["border_side_wide", "border_side_colored"]);
const pseudoSelector = (selector) => /::?(?:before|after)\b/i.test(selector);

// Shapes that use one-sided borders without being a stripe: the same border written out on all four sides, a CSS
// triangle (a zero dimension, two transparent sides, or as a pseudo-element arrow a transparent border all round)
// and a spinner (round and animated).
function decorativeBorders(decls, pseudo) {
	const zero = (name) => /^0(?:px|rem|em)?$/.test((decls.get(name) ?? "").trim());
	if (zero("width") || zero("height")) return true;
	let transparentSides = 0;
	let transparentAll = false;
	for (const [prop, value] of decls) {
		if (!/\btransparent\b/i.test(value)) continue;
		if (prop === "border") transparentAll = true;
		else if (prop === "border-color") transparentSides += topTokens(value).filter((t) => /^transparent$/i.test(t)).length;
		else if (/^border-(?:left|right|top|bottom)(?:-color)?$/.test(prop)) transparentSides += 1;
	}
	// A pseudo-element arrow is sized by its borders alone; a pseudo-element stripe has an extent of its own.
	const sized = (name) => decls.has(name) && !/^(?:auto|0(?:px|rem|em)?)$/.test(decls.get(name).trim());
	const extent = ["width", "height", "inline-size", "block-size", "inset"].some(sized) || (decls.has("top") && decls.has("bottom")) || (decls.has("left") && decls.has("right"));
	if (transparentSides >= 2 || (pseudo && transparentAll && !extent)) return true;
	for (const family of [/^border-(?:top|right|bottom|left)$/, /^border-(?:top|right|bottom|left)-color$/, /^border-(?:top|right|bottom|left)-width$/]) {
		const values = [...decls].filter(([prop]) => family.test(prop)).map(([, value]) => value);
		if (values.length === 4 && new Set(values).size === 1) return true; // the same border on all four sides
	}
	return [...decls.keys()].some((prop) => /^animation(?:-name)?$/.test(prop)) && /^(?:50%|100%|9{3,}px)/.test(decls.get("border-radius") ?? "");
}

// Walks `text` once, keeping a stack of open rule blocks. Declarations are checked as they are read; each
// block is checked as a whole (geometry, quote selectors, decorative borders) when it closes.
function scanCss(text, ctx, report) {
	htmlQuoteBars(text, report);
	const newBlock = (selector, index) => ({ selector, decls: new Map(), index, pending: [], sawBrace: false });
	const stack = [];
	let current = newBlock("", 0);
	let chunk = 0;
	let depth = 0;

	const statement = (end) => {
		const parsed = parseChunk(text.slice(chunk, end));
		if (!parsed) return;
		if (parsed.apply !== undefined) {
			const classes = pseudoSelector(current.selector) ? parsed.apply.split(/\s+/).map((c) => (c ? `before:${c}` : c)).join(" ") : parsed.apply;
			for (const rule of analyseClasses(classes, ctx)) report(rule, chunk);
			return;
		}
		const index = chunk + parsed.at;
		current.decls.set(parsed.prop, parsed.value);
		checkDecl(parsed.prop, parsed.value, ctx, (rule) => current.pending.push({ rule, index }));
		if (QUOTE_SELECTOR.test(current.selector) && LEFT_BORDER_PROP.test(parsed.prop) && visibleBorder(parsed.value)) report("quote_bar", index);
	};
	const closeBlock = (block) => {
		const pseudo = pseudoSelector(block.selector);
		const decorative = decorativeBorders(block.decls, pseudo);
		for (const { rule, index } of block.pending) if (!(decorative && SIDE_BORDER_RULES.has(rule))) report(rule, index);
		if (block.selector === "" && block.sawBrace) return;
		for (const rule of boxRules(block.decls, pseudo, ctx)) report(rule, block.index);
	};

	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === "(") depth++;
		else if (c === ")") depth = Math.max(0, depth - 1);
		else if (c === "{" && DECLARATION_START.test(text.slice(chunk, chunk + 200))) {
			let open = 1;
			while (open > 0 && ++i < text.length) open += text[i] === "{" ? 1 : text[i] === "}" ? -1 : 0;
		} else if (c === "{") {
			current.sawBrace = true;
			stack.push(current);
			current = newBlock(text.slice(chunk, i).trim().replace(/\s+/g, " "), chunk);
			chunk = i + 1;
			depth = 0;
		} else if (c === "}") {
			statement(i);
			closeBlock(current);
			current = stack.pop() ?? newBlock("", 0);
			chunk = i + 1;
			depth = 0;
		} else if (c === ";" && depth === 0) {
			statement(i);
			chunk = i + 1;
		}
	}
	statement(text.length);
	closeBlock(current);
}

// ---------------------------------------------------------------------------------------------------------
// Tailwind class lists
// ---------------------------------------------------------------------------------------------------------

function parseClassToken(raw) {
	const cuts = [];
	let depth = 0;
	for (let i = 0; i < raw.length; i++) {
		const c = raw[i];
		if (c === "[" || c === "(") depth++;
		else if (c === "]" || c === ")") depth = Math.max(0, depth - 1);
		else if (c === ":" && depth === 0) cuts.push(i);
	}
	const variants = [];
	let from = 0;
	for (const cut of cuts) {
		variants.push(raw.slice(from, cut));
		from = cut + 1;
	}
	return { raw, base: raw.slice(from).replace(/^!|!$/g, ""), variants };
}

const TW_NEUTRAL = /^(?:transparent|current|inherit|black|white|(?:slate|gray|zinc|neutral|stone|taupe|mauve|mist|olive)(?:-\d+)?|kumo-(?:line|fill|fill-hover|recessed|tint|base|surface|elevated|overlay|control|contrast|interact|ring|default|strong|subtle|inactive|inverse|neutral-\d+|tip-[a-z]+))$/;
const TW_NOT_COLOR = /^(?:\d+|px|collapse|separate|spacing.*|solid|dashed|dotted|double|none|hidden|opacity-.*)$/;
const BG_NOT_COLOR = /^(?:gradient|linear|radial|conic|no-repeat|repeat|left|right|top|bottom|center|cover|contain|auto|fixed|local|scroll|clip-|origin-|blend-|none|size-|position-|\[(?:length|size|position|image|url):)/;

// Allow-list first, then the project's own theme colours (--color-<name>), then the words in the name.
function twColorChromatic(name, ctx) {
	const bare = name.replace(/\/(?:\d+|\[[^\]]*\])$/, "");
	if (bare.startsWith("[")) return isChromatic(bare.slice(1, -1).replace(/^color:/, "").replace(/_/g, " "), ctx);
	const variable = /^\((--[\w-]+)\)$/.exec(bare);
	if (variable) return isChromatic(`var(${variable[1]})`, ctx);
	if (TW_NEUTRAL.test(bare)) return false;
	return varChromatic(`--color-${bare}`, ctx, 0);
}

// What follows `border-<side>-`: a width, a style word, or a colour.
function twBorderPart(rest, ctx) {
	if (TW_NOT_COLOR.test(rest)) return {};
	const arbitrary = /^\[(.*)\]$/.exec(rest)?.[1] ?? (/^\(--[\w-]+\)$/.test(rest) ? `var${rest}` : null);
	if (arbitrary !== null) {
		let inner = arbitrary.replace(/_/g, " ");
		const hint = /^(length|color):/.exec(inner)?.[1];
		if (hint) inner = inner.slice(hint.length + 1);
		const px = lengthPx(inner);
		if (hint === "length" || (!hint && px !== null)) return { width: px ?? maxLengthIn(inner) };
		return { chromatic: isChromatic(inner, ctx) };
	}
	return { chromatic: twColorChromatic(rest, ctx) };
}

function twLength(value, ctx) {
	if (value === "px") return { px: 1 };
	if (value === "full") return { pct: 100 };
	if (value === "auto") return { auto: true };
	const fraction = /^(\d+)\/(\d+)$/.exec(value);
	if (fraction) return { pct: (Number(fraction[1]) / Number(fraction[2])) * 100 };
	if (/^\d+(?:\.\d+)?$/.test(value)) return { px: Number(value) * 4 };
	const arbitrary = /^\[(.*)\]$/.exec(value);
	return arbitrary ? cssLength(arbitrary[1].replace(/_/g, " "), ctx) : null;
}

function twGradient(tokens, ctx) {
	const direction = tokens.find((t) => /^bg-(?:gradient-to-|linear-(?:to-|\d))/.test(t.base));
	if (!direction) return null;
	const sides = /^bg-(?:gradient|linear)-to-(.+)$/.exec(direction.base)?.[1];
	const angle = /^bg-linear-(\d+)$/.exec(direction.base)?.[1];
	const axis = sides ? (/^[tb]$/.test(sides) ? "y" : /^[lr]$/.test(sides) ? "x" : null) : angle ? gradientAxis(`${angle}deg`) : null;
	const stops = tokens.map((t) => /^(from|via|to)-(.+)$/.exec(t.base)?.[2]).filter(Boolean);
	const isPosition = (s) => /^\d+%$|^\[[\d.]+(?:px|rem|%)\]$/.test(s);
	const positions = stops.filter(isPosition).map((s) => s.replace(/^\[|\]$/g, ""));
	const colors = stops.filter((s) => !isPosition(s));
	return {
		axis,
		hardStop: positions.some((p, i) => positions.indexOf(p) !== i && thinEdge(p)),
		transparent: colors.some((c) => c === "transparent" || /\/0$/.test(c)),
		chromatic: colors.some((c) => c !== "transparent" && twColorChromatic(c, ctx)),
	};
}

function boxFromTokens(tokens, ctx) {
	const box = { edges: new Set(), position: "", paint: undefined };
	const gradient = twGradient(tokens, ctx);
	if (gradient) box.paint = gradient.chromatic ? "chromatic" : "neutral";
	for (const { base } of tokens) {
		let m;
		if ((m = /^(absolute|fixed|sticky)$/.exec(base))) box.position = m[1];
		else if ((m = /^w-(.+)$/.exec(base))) box.w = twLength(m[1], ctx);
		else if ((m = /^h-(.+)$/.exec(base))) box.h = twLength(m[1], ctx);
		else if ((m = /^size-(.+)$/.exec(base))) box.w = box.h = twLength(m[1], ctx);
		else if (base === "self-stretch") box.stretchY = true;
		else if ((m = /^-?(top|bottom|left|right|start|end)-(?!auto$)/.exec(base))) box.edges.add({ start: "left", end: "right" }[m[1]] ?? m[1]);
		else if ((m = /^-?inset-([xy]|[se]|block|inline)?-?/.exec(base)) && !/^-?inset-shadow/.test(base)) {
			const axis = m[1];
			const add = axis === "x" || axis === "inline" ? ["left", "right"] : axis === "y" || axis === "block" ? ["top", "bottom"] : axis === "s" ? ["left"] : axis === "e" ? ["right"] : ["top", "bottom", "left", "right"];
			add.forEach((e) => box.edges.add(e));
		} else if ((m = /^bg-(.+)$/.exec(base)) && !BG_NOT_COLOR.test(m[1])) {
			const chromatic = twColorChromatic(m[1], ctx);
			box.paint = chromatic || box.paint === "chromatic" ? "chromatic" : "neutral";
		}
	}
	box.stretchY ||= box.edges.has("top") && box.edges.has("bottom");
	box.stretchX = box.edges.has("left") && box.edges.has("right");
	return box;
}

const parseClassList = (text) => text.split(/\s+/).filter((t) => t.length > 1).map(parseClassToken);
const isPseudoVariant = (v) => v === "before" || v === "after" || /::?(?:before|after)\b/.test(v);

// One-sided border classes. Returns the tw_border_* rules a token list triggers.
function twBorderRules(tokens, ctx) {
	const rules = new Set();
	const bare = [];
	const accents = [];
	for (const { base } of tokens) {
		let m;
		if ((m = /^border-([lrtbsexy])(?:-(.+))?$/.exec(base))) {
			if (m[2] === undefined || m[2] === "1") bare.push(base);
			else if (/^\d+$/.test(m[2])) {
				if (Number(m[2]) >= 2) rules.add("tw_border_wide");
			} else {
				const part = twBorderPart(m[2], ctx);
				if (part.width !== undefined) {
					if (part.width >= THICK_PX) rules.add("tw_border_wide");
					else if (part.width > 0) bare.push(base);
				}
				if (part.chromatic) rules.add("tw_border_colored");
			}
		} else if ((m = /^divide-([xy])(?:-(\d+))?$/.exec(base))) {
			if (m[2] === undefined || m[2] === "1") bare.push(base);
			else if (Number(m[2]) >= 2) rules.add("tw_border_wide");
		} else if ((m = /^(?:border|divide)-(.+)$/.exec(base)) && !/^[lrtbsexy](?:-|$)/.test(m[1]) && !/^[xy]-reverse$/.test(m[1])) {
			if (twBorderPart(m[1], ctx).chromatic) accents.push(base);
		}
	}
	if (bare.length > 0 && accents.length > 0) rules.add("tw_border_plus_accent");
	return rules;
}

// Spinners and CSS triangles use one-sided borders on purpose (see decorativeBorders for the CSS twin).
function decorativeTokens(tokens) {
	if (tokens.some((t) => t.base === "animate-spin")) return true;
	if (tokens.some((t) => /^(?:size|w|h)-0$/.test(t.base))) return true;
	if (tokens.some((t) => t.variants.some(isPseudoVariant) && t.base === "border-transparent")) return true;
	const transparentSides = tokens.reduce((sum, t) => sum + (/^border-[xy]-transparent$/.test(t.base) ? 2 : /^border-[lrtbse]-transparent$/.test(t.base) ? 1 : 0), 0);
	return transparentSides >= 2;
}

// An underline 2px or thicker in a chromatic colour: `decoration-2 decoration-blue-500`.
function thickColoredUnderline(tokens, ctx) {
	const thick = tokens.some((t) => /^decoration-(?:[2-9]|\d{2,})$/.test(t.base));
	return thick && tokens.some((t) => {
		const name = /^decoration-(.+)$/.exec(t.base)?.[1];
		return name !== undefined && !/^(?:\d+|auto|from-font|solid|double|dotted|dashed|wavy|clone|slice)$/.test(name) && twColorChromatic(name, ctx);
	});
}

// Returns the set of rule names a class list triggers. Tokens are merged across the whole expression, so
// `border-l ${on ? "border-blue-500" : ""}` is read as one list.
function analyseClasses(text, ctx) {
	const rules = new Set();
	const tokens = parseClassList(text);
	if (tokens.length === 0) return rules;

	if (!decorativeTokens(tokens)) for (const rule of twBorderRules(tokens, ctx)) rules.add(rule);
	if (thickColoredUnderline(tokens, ctx)) rules.add("underline_bar");

	// Arbitrary values hand over to the declaration rules: shadow-[...], [box-shadow:...], bg-[...].
	for (const { base, variants } of tokens) {
		let m;
		if ((m = /^(?:inset-|drop-)?shadow-\[(.*)\]$/.exec(base))) {
			const rule = shadowRule(m[1].replace(/_/g, " "), ctx);
			if (rule) rules.add(rule);
		} else if ((m = /^\[([a-z-]+):(.+)\]$/.exec(base))) {
			checkDecl(m[1], m[2].replace(/_/g, " "), ctx, (rule) => rules.add(rule));
		} else if ((m = /^bg-\[(?:(length|size|image|url|position|color):)?(.*)\]$/.exec(base))) {
			const inner = m[2].replace(/_/g, " ");
			if (m[1] === "length" || m[1] === "size") checkDecl("background-size", inner, ctx, (rule) => rules.add(rule));
			else if (/gradient\(/i.test(inner)) checkDecl("background", inner, ctx, (rule) => rules.add(rule));
		}
		if (variants.some((v) => QUOTE_SELECTOR.test(v)) && TW_LEFT_BORDER.test(base)) rules.add("quote_bar");
	}

	const gradient = twGradient(tokens, ctx);
	if (gradient?.hardStop) rules.add("gradient_hard_stop");
	if (gradient?.axis && gradient.transparent && gradient.chromatic) rules.add("gradient_accent_fade");

	// Geometry: tokens that style the same element (or the same pseudo-element) form one box.
	const groups = new Map();
	for (const token of tokens) {
		const signature = token.variants.filter((v) => isPseudoVariant(v) || v.startsWith("[")).join(" ");
		if (!groups.has(signature)) groups.set(signature, []);
		groups.get(signature).push(token);
	}
	for (const [signature, group] of groups) {
		const rule = barRule(boxFromTokens(group, ctx), signature.split(" ").some(isPseudoVariant));
		if (rule) rules.add(rule);
	}
	return rules;
}

// ---------------------------------------------------------------------------------------------------------
// TypeScript and JavaScript: read through the syntax tree
// ---------------------------------------------------------------------------------------------------------

const CLASS_ATTR = /^(?:class|className|classNames|classes|\w+ClassName|\w+Classes)$/;
const CLASS_FN = /^(?:cn|clsx|cx|cva|tv|twMerge|twJoin|classNames|classnames)$/;
const STRING_METHOD = /^(?:join|concat|trim|trimStart|trimEnd|filter)$/;

function analyseScript(path, text, ctx, report) {
	const ext = extname(path).toLowerCase();
	const kind = ext === ".tsx" ? ts.ScriptKind.TSX : ext === ".jsx" ? ts.ScriptKind.JSX : [".js", ".mjs", ".cjs"].includes(ext) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
	const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
	const start = (node) => node.getStart(sf);

	const consts = new Map();
	(function collect(node) {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
			consts.set(node.name.text, [...(consts.get(node.name.text) ?? []), node.initializer]);
		}
		ts.forEachChild(node, collect);
	})(sf);

	// Kumo imports decide whether `variant="underline"` and `<Kumo.Collapsible>` count.
	let kumoFile = false;
	const kumoNamespaces = new Set();
	for (const statement of sf.statements) {
		const specifier = (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier;
		if (!specifier || !ts.isStringLiteral(specifier) || !specifier.text.startsWith("@cloudflare/kumo")) continue;
		kumoFile = true;
		if (/collapsible/i.test(specifier.text)) report("kumo_collapsible", start(statement));
		if (ts.isImportDeclaration(statement)) {
			const bindings = statement.importClause?.namedBindings;
			if (bindings && ts.isNamespaceImport(bindings)) kumoNamespaces.add(bindings.name.text);
			if (bindings && ts.isNamedImports(bindings) && bindings.elements.some((e) => (e.propertyName ?? e.name).text === "Collapsible")) report("kumo_collapsible", start(statement));
		} else if (statement.exportClause && ts.isNamedExports(statement.exportClause) && statement.exportClause.elements.some((e) => (e.propertyName ?? e.name).text === "Collapsible")) {
			report("kumo_collapsible", start(statement));
		}
	}

	// The identifier a runtime value comes from: `theme.line`, `p.theme.line` and `() => theme.line` all give "line".
	function dynName(node) {
		if (ts.isIdentifier(node)) return node.text;
		if (ts.isPropertyAccessExpression(node)) return node.name.text;
		if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) return node.argumentExpression.text;
		if (ts.isCallExpression(node)) return dynName(node.expression);
		if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return ts.isBlock(node.body) ? "" : dynName(node.body);
		if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node)) return dynName(node.expression);
		return "";
	}

	const product = (lists) => lists.reduce((acc, list) => acc.flatMap((a) => list.map((b) => a + b)).slice(0, 8), [""]);
	const some = (list) => list.slice(0, 8);
	// Every string a node can evaluate to, with DYN standing in for values only known at runtime.
	function valueStrings(node, depth = 0) {
		if (!node || depth > 4) return [DYN];
		const next = (n) => valueStrings(n, depth + 1);
		if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return [node.text];
		if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node) || ts.isJsxExpression(node)) return next(node.expression);
		if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) return next(node.operand).map((s) => `-${s}`);
		if (ts.isTemplateExpression(node)) return product([[node.head.text], ...node.templateSpans.flatMap((s) => [next(s.expression), [s.literal.text]])]);
		if (ts.isConditionalExpression(node)) return some([...next(node.whenTrue), ...next(node.whenFalse)]);
		if (ts.isBinaryExpression(node)) {
			const op = node.operatorToken.kind;
			if (op === ts.SyntaxKind.PlusToken) return product([next(node.left), next(node.right)]);
			if (op === ts.SyntaxKind.AmpersandAmpersandToken) return next(node.right);
			if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) return some([...next(node.left), ...next(node.right)]);
		}
		if (ts.isIdentifier(node) && consts.has(node.text)) return some(consts.get(node.text).slice(0, 4).flatMap(next));
		if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "join" && ts.isArrayLiteralExpression(node.expression.expression)) {
			const separator = node.arguments[0] ? (next(node.arguments[0])[0] ?? ",") : ",";
			return product(node.expression.expression.elements.flatMap((element, i) => (i === 0 ? [next(element)] : [[separator], next(element)])));
		}
		return [dyn(dynName(node))];
	}

	// The strings of an expression that composes a class list. It stops at JSX and function bodies and follows
	// identifiers to their constants once each (capped, so a bundle full of shared constants stays linear).
	const constStrings = new Map();
	function stringsOfConst(name) {
		if (!constStrings.has(name)) {
			constStrings.set(name, []); // breaks cycles
			const out = [];
			for (const init of consts.get(name)) if (out.length < 64) collectStrings(init, out);
			constStrings.set(name, out.slice(0, 64));
		}
		return constStrings.get(name);
	}
	function collectStrings(node, out = [], anyCall = false) {
		if (ts.isStringLiteralLike(node)) out.push(node.text);
		else if (ts.isIdentifier(node) && consts.has(node.text)) out.push(...stringsOfConst(node.text));
		else if (ts.isTemplateExpression(node)) {
			out.push(node.head.text);
			for (const span of node.templateSpans) {
				collectStrings(span.expression, out, anyCall);
				out.push(span.literal.text);
			}
		} else if (!isBoundary(node) && !(ts.isCallExpression(node) && !anyCall && !isClassCall(node))) {
			ts.forEachChild(node, (child) => {
				collectStrings(child, out, anyCall); // returning a truthy value from the callback would stop the walk
			});
		}
		return out;
	}

	const isBoundary = (node) => ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node) || ts.isFunctionLike(node) || ts.isClassLike(node);
	const calleeName = (call) => (ts.isIdentifier(call.expression) ? call.expression.text : ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : "");
	// Calls whose arguments build a class list. Other calls (`jsx("div", ...)`, `t("key")`) do not.
	const isClassCall = (call) => CLASS_FN.test(calleeName(call)) || isClassListCall(call) || (ts.isPropertyAccessExpression(call.expression) && STRING_METHOD.test(call.expression.name.text));
	const isClassListCall = (call) => ts.isPropertyAccessExpression(call.expression) && /^(?:add|remove|toggle|replace)$/.test(call.expression.name.text) && /classList$/.test(call.expression.expression.getText(sf));
	const isClassRoot = (n) =>
		(ts.isJsxAttribute(n) && n.initializer !== undefined && CLASS_ATTR.test(n.name.getText(sf))) ||
		(ts.isCallExpression(n) && (CLASS_FN.test(calleeName(n)) || isClassListCall(n))) ||
		ts.isStringLiteralLike(n) || ts.isTemplateExpression(n) || ts.isConditionalExpression(n) || ts.isBinaryExpression(n) || ts.isArrayLiteralExpression(n);

	// React and CSS-in-JS read a bare number as pixels.
	const asValue = (prop, raw) => (PX_PROP.test(prop) && /^-?\d*\.?\d+$/.test(raw) ? `${raw}px` : raw);
	// An array, object or function is never a CSS value (it is data that happens to be keyed by a property name).
	const isDataShape = (n) => ts.isArrayLiteralExpression(n) || ts.isObjectLiteralExpression(n) || ts.isFunctionLike(n) || ts.isNewExpression(n);
	const declare = (prop, expression, index, sink = report) => {
		if (isDataShape(expression)) return;
		for (const raw of valueStrings(expression)) checkDecl(prop, asValue(prop, raw), ctx, (rule) => sink(rule, index));
	};
	const keyName = (name) => (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name) ? name.text : ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression) ? name.expression.text : null);

	// The declarations of a style object; `sink` receives the rules each property triggers.
	function readStyle(node, sink) {
		const decls = new Map();
		for (const property of node.properties) {
			const key = ts.isPropertyAssignment(property) ? keyName(property.name) : ts.isShorthandPropertyAssignment(property) ? property.name.text : null;
			if (key === null) continue;
			const expression = ts.isPropertyAssignment(property) ? property.initializer : property.name;
			const prop = kebab(key);
			declare(prop, expression, start(property), sink);
			if (!isDataShape(expression)) decls.set(prop, asValue(prop, valueStrings(expression)[0]));
		}
		return decls;
	}

	function styleObject(node) {
		const pending = [];
		const decls = readStyle(node, (rule, index) => pending.push({ rule, index }));
		const parentKey = ts.isPropertyAssignment(node.parent) ? keyName(node.parent.name) : null;
		const pseudo = parentKey !== null && pseudoSelector(parentKey);
		const decorative = decorativeBorders(decls, pseudo);
		for (const { rule, index } of pending) if (!(decorative && SIDE_BORDER_RULES.has(rule))) report(rule, index);
		for (const rule of boxRules(decls, pseudo, ctx)) report(rule, start(node));
		if (parentKey !== null && QUOTE_SELECTOR.test(parentKey)) {
			for (const [prop, value] of decls) if (LEFT_BORDER_PROP.test(prop) && visibleBorder(value)) report("quote_bar", start(node));
		}
		if (kumoFile && decls.get("variant")?.toLowerCase() === "underline") report("kumo_underline_tabs", start(node));
	}

	// className and style on one element describe one box: `w-1 self-stretch` plus `style={{ background: color }}`.
	// A <blockquote> (or any element with "quote" in its class) must not carry a left border at all.
	function elementBox(node) {
		let classes = null;
		let style = null;
		for (const attr of node.attributes.properties) {
			if (!ts.isJsxAttribute(attr) || !attr.initializer) continue;
			const name = attr.name.getText(sf);
			if (name === "className" || name === "class") classes = attr;
			else if (name === "style" && ts.isJsxExpression(attr.initializer) && attr.initializer.expression && ts.isObjectLiteralExpression(attr.initializer.expression)) style = attr.initializer.expression;
		}
		const classText = classes ? collectStrings(classes, [], true).join(" ") : "";
		const decls = style ? readStyle(style, () => {}) : new Map();
		if (node.tagName.getText(sf) === "blockquote" || QUOTE_SELECTOR.test(classText)) {
			const leftBorder = [...decls].some(([prop, value]) => LEFT_BORDER_PROP.test(prop) && visibleBorder(value));
			if (leftBorder || parseClassList(classText).some((t) => TW_LEFT_BORDER.test(t.base))) report("quote_bar", start(node));
		}
		if (!classes || !style) return;
		const plain = parseClassList(classText).filter((t) => !t.variants.some((v) => isPseudoVariant(v) || v.startsWith("[")));
		const rule = barRule(mergeBoxes(boxFromTokens(plain, ctx), boxFromDecls(decls, ctx)), false);
		if (rule) report(rule, start(node));
	}

	// The text of a string or template, with a map from an offset in it back to the source file. A placeholder
	// stands where each ${} was, so offsets shift by the difference in length.
	function literalText(node) {
		if (!ts.isTemplateExpression(node)) return { body: node.text, toSource: (offset) => start(node) + 1 + offset };
		let body = node.head.text;
		const marks = [{ at: 0, source: node.head.getStart(sf) + 1 }];
		for (const span of node.templateSpans) {
			body += dyn(dynName(span.expression));
			marks.push({ at: body.length, source: span.literal.getStart(sf) + 1 });
			body += span.literal.text;
		}
		const toSource = (offset) => {
			const mark = marks.findLast((m) => m.at <= offset);
			return mark.source + offset - mark.at;
		};
		return { body, toSource };
	}

	function literal(node) {
		const { body, toSource } = literalText(node);
		if (GLYPH_ONLY.test(body)) report("glyph_bar", start(node));
		if (body.length < 4 || !/[:{]/.test(body)) return;
		scanCss(stripComments(body, ".txt"), ctx, (rule, offset) => report(rule, toSource(offset)));
	}

	function visit(node, inRoot) {
		if (!inRoot && isClassRoot(node)) {
			inRoot = true;
			for (const rule of analyseClasses(collectStrings(node, [], ts.isJsxAttribute(node)).join(" "), ctx)) report(rule, start(node));
		}
		if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) literal(node);
		else if (ts.isObjectLiteralExpression(node)) styleObject(node);
		else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
			const left = node.left;
			const target = ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left) ? left.expression.getText(sf) : "";
			const name = ts.isPropertyAccessExpression(left) ? left.name.text : ts.isElementAccessExpression(left) && ts.isStringLiteralLike(left.argumentExpression) ? left.argumentExpression.text : null;
			if (name !== null && /(?:^|\.)style$/.test(target)) declare(kebab(name), node.right, start(node));
		} else if (ts.isCallExpression(node)) {
			if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "setProperty" && node.arguments.length >= 2 && ts.isStringLiteralLike(node.arguments[0])) {
				declare(kebab(node.arguments[0].text), node.arguments[1], start(node));
			}
			if (node.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteralLike(node.arguments[0]) && /^@cloudflare\/kumo.*collapsible/i.test(node.arguments[0].text)) {
				report("kumo_collapsible", start(node));
			}
		} else if (ts.isJsxText(node)) {
			if (GLYPH_ONLY.test(node.text)) report("glyph_bar", start(node));
		} else if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
			elementBox(node);
		} else if (ts.isJsxAttribute(node)) {
			if (kumoFile && node.name.getText(sf) === "variant" && node.initializer && valueStrings(node.initializer).some((v) => v.toLowerCase() === "underline")) report("kumo_underline_tabs", start(node));
		} else if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && kumoNamespaces.has(node.expression.text) && node.name.text === "Collapsible") {
			report("kumo_collapsible", start(node));
		}
		ts.forEachChild(node, (child) => visit(child, inRoot && !isBoundary(child)));
	}
	visit(sf, false);
}

// ---------------------------------------------------------------------------------------------------------
// Entry point: one file in, hits out
// ---------------------------------------------------------------------------------------------------------

// Returns [{ rule, index, line }] without duplicates (one hit per rule per line), in file order.
function analyse(path, text, ctx) {
	const ext = extname(path).toLowerCase();
	const found = [];
	const report = (rule, index) => found.push({ rule, index });
	try {
		if (SCRIPT_EXTENSIONS.has(ext)) analyseScript(path, text, ctx, report);
		else {
			const source = stripComments(text, ext);
			scanCss(source, ctx, report);
			if (ext !== ".css") {
				for (const m of source.matchAll(/"([^"\n]*)"|'([^'\n]*)'|`([^`]*)`/g)) {
					for (const rule of analyseClasses(m[1] ?? m[2] ?? m[3], ctx)) report(rule, m.index);
				}
			}
		}
	} catch (error) {
		throw new Error(`could not analyse ${path}: ${error.message}`, { cause: error });
	}
	const seen = new Set();
	const starts = lineStarts(text);
	return found
		.sort((a, b) => a.index - b.index)
		.map((hit) => ({ ...hit, line: lineOf(starts, hit.index) }))
		.filter((hit) => !seen.has(`${hit.rule}@${hit.line}`) && seen.add(`${hit.rule}@${hit.line}`));
}

export { analyse, buildContext, isChromatic };
