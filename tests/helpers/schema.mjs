/** Split a migration file into statements, keeping trigger bodies whole. */
export function statements(text) {
	const out = [];
	let current = [];
	let inTrigger = false;
	for (const line of text.split("\n")) {
		if (!current.length && (!line.trim() || line.trim().startsWith("--"))) continue;
		current.push(line);
		if (/^\s*CREATE TRIGGER/i.test(line)) inTrigger = true;
		if (inTrigger ? /^\s*END;\s*$/i.test(line) : /;\s*(--.*)?$/.test(line)) {
			out.push(current.join("\n"));
			current = [];
			inTrigger = false;
		}
	}
	return out;
}
