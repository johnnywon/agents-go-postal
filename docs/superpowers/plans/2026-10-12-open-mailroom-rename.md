# Open Mailroom Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship 0.4.0 as one PR: every public mention of "Agents Go Postal" / "AGP" becomes "Open Mailroom" / "OMR", the wordmark logo leaves the product and README, and the README screenshots are reshot.

**Architecture:** Mostly find and replace. Three spots need care so existing deployments keep working: the `AGP_*` build env vars stay as fallbacks, browser prefs under `agp-*` localStorage keys are read once and moved to `omr-*`, and Durable Object class names and migration tags stay unchanged (they never contained the name). The app icon (the @ mark with no name) stays. The watermark and stacked wordmark are deleted. The link preview card becomes the @ mark on green with no wordmark.

**Tech Stack:** React Router v7, Cloudflare Workers, node:test (`npm test`), ImageMagick for the preview card, gstack `/browse` for screenshots.

**Names used throughout**

| Old | New |
|---|---|
| Agents Go Postal | Open Mailroom |
| agents-go-postal (package, worker, R2 bucket, repo) | open-mailroom |
| AGP (prose short name, manifest `short_name`) | Open Mailroom (no short form in prose); manifest `short_name`: `Mailroom` |
| `AGP_WRANGLER_CONFIG`, `AGP_PUBLIC_DIR` | `OMR_WRANGLER_CONFIG`, `OMR_PUBLIC_DIR` (old names still read) |
| `agp-prefs`, `agp-layout`, `agp-shortcuts-seen`, `agp-compose-handoff`, `agp-compose-*` | `omr-prefs`, `omr-layout`, `omr-shortcuts-seen`, `omr-compose-handoff`, `omr-compose-*` |
| github.com/johnnywon/agents-go-postal | github.com/johnnywon/open-mailroom |

**Running in a cloud session:** work on this branch (`open-mailroom`); Task 0 is already done. Do Tasks 1-6 and 8. Skip Task 7 (screenshots are shot on Johnny's Mac) and skip the tag in Task 9. Push the branch; Johnny opens the PR from the app. `gh pr create` and tag pushes are blocked in cloud sessions.

**Precondition (Johnny):** the GitHub repo is renamed to `open-mailroom` before this PR merges, so the README links and Deploy button resolve. GitHub redirects the old URL.

---

### Task 0: Branch

- [ ] **Step 1:** `git checkout -b open-mailroom`

---

### Task 1: Build env vars with fallback

**Files:**
- Modify: `vite.config.ts:14-15`
- Modify: `package.json` (`dev:local` script)

- [ ] **Step 1: Read new names first, old names second**

```ts
const wranglerConfig = process.env.OMR_WRANGLER_CONFIG ?? process.env.AGP_WRANGLER_CONFIG;
const publicDir = process.env.OMR_PUBLIC_DIR ?? process.env.AGP_PUBLIC_DIR;
```

- [ ] **Step 2:** In `package.json`, `"dev:local": "OMR_WRANGLER_CONFIG=wrangler.local.jsonc react-router dev"`.

- [ ] **Step 3: Verify both names work**

Run: `AGP_PUBLIC_DIR=public npm run build && OMR_PUBLIC_DIR=public npm run build`
Expected: both succeed.

- [ ] **Step 4: Commit** `git commit -am "Build env vars: OMR_* with AGP_* fallback"`

---

### Task 2: localStorage keys move once

**Files:**
- Modify: `app/components/postal/prefs.ts:22-23`
- Modify: `app/components/postal/compose.ts:365,373`
- Modify: `app/components/postal/PostalMail.tsx:40`
- Test: `tests/storage-keys.test.mjs` (create)

- [ ] **Step 1: Write the failing test**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

test("no agp- storage key is written", () => {
	const files = execSync("git ls-files app shared", { encoding: "utf8" }).trim().split("\n");
	const hits = files.filter((f) => /\.(ts|tsx)$/.test(f) && /["'`]agp-(?!prefs"|layout"|shortcuts-seen")/.test(readFileSync(f, "utf8")));
	assert.deepEqual(hits, []);
});

test("old prefs keys are migrated, not dropped", () => {
	const prefs = readFileSync("app/components/postal/prefs.ts", "utf8");
	assert.match(prefs, /LEGACY_KEYS/);
});
```

- [ ] **Step 2:** Run `node --test tests/storage-keys.test.mjs`. Expected: FAIL (compose handoff key and no `LEGACY_KEYS`).

- [ ] **Step 3: Implement in `prefs.ts`**

```ts
const PREFS_KEY = "omr-prefs";
const LAYOUT_KEY = "omr-layout";
const SEEN_SHORTCUTS_KEY = "omr-shortcuts-seen";
// Keys from before 0.4.0. Read once, copied to the new key, then removed.
const LEGACY_KEYS: Record<string, string> = { "agp-prefs": PREFS_KEY, "agp-layout": LAYOUT_KEY, "agp-shortcuts-seen": SEEN_SHORTCUTS_KEY };

export function migrateStorageKeys(): void {
	try {
		for (const [old, next] of Object.entries(LEGACY_KEYS)) {
			const value = localStorage.getItem(old);
			if (value !== null && localStorage.getItem(next) === null) localStorage.setItem(next, value);
			localStorage.removeItem(old);
		}
	} catch {}
}
```

Export `SEEN_SHORTCUTS_KEY` from `prefs.ts` and import it in `PostalMail.tsx` in place of the local constant at line 40. Call `migrateStorageKeys()` once at module load in `prefs.ts`, above the first read of `PREFS_KEY`.

- [ ] **Step 4:** In `compose.ts`, `HANDOFF_KEY = "omr-compose-handoff"` and the window name `` `omr-compose-${Date.now()}` ``. These are transient, so no migration.

- [ ] **Step 5:** `node --test tests/storage-keys.test.mjs && npm run typecheck`. Expected: PASS.

- [ ] **Step 6: Commit** `git commit -am "Storage keys: omr-*, old prefs carried over once"`

---

### Task 3: Name in code and config

**Files:**
- Modify: `app/lib/brand.ts:3` → `export const DEFAULT_APP_NAME = "Open Mailroom";`
- Modify: `workers/lib/agent-model.ts:164` → `"X-Title": "Open Mailroom"`
- Modify: `wrangler.jsonc:3,16,41,42` → `"name": "open-mailroom"`, `"APP_NAME": "Open Mailroom"`, both bucket names `open-mailroom`
- Modify: `package.json` → `"name": "open-mailroom"`, `"label": "Open Mailroom"`
- Modify: `public/site.webmanifest` → `"name": "Open Mailroom"`, `"short_name": "Mailroom"`
- Modify: `scripts/d1-bench/wrangler.jsonc`, `scripts/d1-bench/README.md` → `agp-` prefixes become `omr-`
- Modify: `tests/not-found.test.mjs`, `tests/settings-routes.test.mjs` → expected titles say Open Mailroom

- [ ] **Step 1:** Make the edits above. Then `npm install --package-lock-only` to rewrite the lockfile name.
- [ ] **Step 2:** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 3: Commit** `git commit -am "Name: Open Mailroom in code, config and manifest"`

---

### Task 4: Drop the logo from the product

**Files:**
- Modify: `app/components/postal/Sidebar.tsx:267` delete the `<img ... pg-watermark>` line
- Modify: `app/components/postal/Reader.tsx:126` delete the `<img>`; keep `<p>Pick a conversation.</p>`
- Modify: `app/components/ErrorPage.tsx:38` delete the `<img>`
- Modify: `app/components/postal/postal.css` delete the watermark comment and `.postal .pg-watermark` rules (~293-299), `.pg-idle img` rules (580-581), `.pg-fault .pg-fault-logo` rules (585-586); line 582 comment becomes `/* Error pages (404, crashes) share the empty reader's look: one line, a way back. */`
- Modify: `app/index.css:67-…,115-116` delete the `.deck-brand-logo` rules
- Modify: `tests/design-rules.test.mjs` delete the tests "the logo image is never clipped" (~1016) and "the postal logo watermark is never clipped, masked or rounded" (~1110); remove the 0-radius list entry for the logo in the `.postal :is(...)` rule if the test requires it
- Delete: `public/brand/logo.svg`, `logo-stacked.svg`, `logo-stacked-dark.svg`, `watermark.svg`
- Modify: `public/brand/README.md` drop the logo, stacked logo and watermark bullets
- Modify: `DESIGN.md:14` "taken from the logo" → "taken from the app icon"; `DESIGN.md:28` drop "the logo," from the 0-radius list; `DESIGN.md:41` replace with "There is no logo in the app. The name appears only in the page title."

- [ ] **Step 1:** Make the edits.
- [ ] **Step 2:** `git grep -n -E "watermark|deck-brand-logo|logo-stacked|brand/logo" -- app tests public DESIGN.md`. Expected: no output.
- [ ] **Step 3:** `npm test && npm run typecheck && npm run build`. Expected: PASS.
- [ ] **Step 4: Browser check** with `npm run dev:local` and the seed (`docs/development.md`): sidebar foot, empty reader, `/nope` 404 at desktop and 375px, light and dark. No gap where the logo was, no console errors.
- [ ] **Step 5: Commit** `git commit -am "Drop the logo from the sidebar, empty reader and error pages"`

---

### Task 5: Link preview card without the wordmark

**Files:**
- Replace: `public/brand/og-image.png` (1200 × 630)

- [ ] **Step 1: Render the @ mark from the app icon on the icon green, no rounded tile, no name**

```bash
magick -size 1200x630 xc:'#1f9d5a' \( -background none -density 300 public/brand/app-icon.svg -resize 420x420 \) -gravity center -composite public/brand/og-image.png
```

The icon's rounded green tile blends into the same green background. Open the file and check it.

- [ ] **Step 2: Commit** `git commit -am "Preview card: the mark only"`

---

### Task 6: Docs and README text

**Files:** `README.md`, `NOTICE`, `CLAUDE.md`, `docs/setup.md`, `docs/roadmap.md`, `docs/architecture.md`, `docs/guide.md`, `docs/development.md`, `docs/d1-migration-plan.md`, `docs/d1-phase0.md`

- [ ] **Step 1: README header.** Replace lines 1-6 (the `<h1><picture>…</picture></h1>` block) with `# Open Mailroom`.
- [ ] **Step 2: Replace text across the files.**

```bash
git grep -l -E "Agents Go Postal|agents-go-postal|AGP" -- README.md NOTICE CLAUDE.md docs | xargs sed -i '' \
  -e 's/Agents Go Postal/Open Mailroom/g' \
  -e 's/agents-go-postal/open-mailroom/g' \
  -e 's/AGP_WRANGLER_CONFIG/OMR_WRANGLER_CONFIG/g' \
  -e 's/AGP_PUBLIC_DIR/OMR_PUBLIC_DIR/g'
```

- [ ] **Step 3:** Read every remaining hit of `git grep -n -w AGP` and rewrite each by hand ("AGP" in prose becomes "Open Mailroom"). Leave `CHANGELOG.md` history alone.
- [ ] **Step 4:** In `docs/setup.md` near the env var paragraph, add: "`AGP_WRANGLER_CONFIG` and `AGP_PUBLIC_DIR` from before 0.4.0 still work."
- [ ] **Step 5:** `git grep -n -i -E "agents.go.postal|\bagp\b" -- . ':!CHANGELOG.md' ':!docs/superpowers'`. Expected: only the fallback lines in `vite.config.ts`, `prefs.ts` and `docs/setup.md`.
- [ ] **Step 6: Commit** `git commit -am "Docs: Open Mailroom"`

---

### Task 7: Reshoot the README screenshots

**Files:** replace `docs/images/inbox.jpg`, `search.jpg`, `compose.jpg` (2000 × 1250), `mcp.jpg` (1000 × 1704), `mobile.jpg` (1100 × 1146)

- [ ] **Step 1:** `npm run dev:local`, then seed with `{"perMailbox": 15}` (`docs/development.md`). Seed data uses only example.com, example.org and example.net.
- [ ] **Step 2:** With gstack `/browse`, shoot each image at the same size and framing as the old one, dark theme, 2× device scale: inbox with a conversation open and the agent panel showing; search with operators and filters; reply compose with the quote; the MCP panel; the list and a receipt at 375px.
- [ ] **Step 3:** Convert to JPEG at quality 85: `magick in.png -quality 85 docs/images/inbox.jpg` (and so on).
- [ ] **Step 4:** Look at each one. No logo, no old name, no real address or domain.
- [ ] **Step 5: Commit** `git commit -am "README screenshots reshot"`

---

### Task 8: Version 0.4.0

**Files:** `package.json` (`"version": "0.4.0"`), `package-lock.json`, `README.md` (badge and the "v0.3.0, ready to deploy" line), `CHANGELOG.md`

- [ ] **Step 1: CHANGELOG entry** above 0.3.0:

```markdown
## 0.4.0

- Agents Go Postal is now Open Mailroom. The repo moved to github.com/johnnywon/open-mailroom; the old URL redirects.
- The logo is gone from the sidebar, the empty reader and error pages. The app icon stays. The link preview card shows the mark without a name.
- Build env vars are `OMR_WRANGLER_CONFIG` and `OMR_PUBLIC_DIR`. `AGP_*` still work.
- Browser prefs move from `agp-*` to `omr-*` keys on first load. Nothing to do.
- The default worker and R2 bucket names in `wrangler.jsonc` are `open-mailroom`. An existing deployment keeps its own names; don't change them, or Cloudflare creates a new worker and an empty bucket.
- README screenshots reshot.

No D1 migration.
```

- [ ] **Step 2:** `npm install --package-lock-only && npm test && npm run typecheck && npm run build`. Expected: PASS.
- [ ] **Step 3: Commit** `git commit -am "0.4.0"`

---

### Task 9: PR

- [ ] **Step 1:** `git push -u origin open-mailroom` and open the PR titled "0.4.0: Agents Go Postal is now Open Mailroom; logo out, screenshots reshot", body from the changelog entry.
- [ ] **Step 2:** CI green. Squash-merge. Tag `v0.4.0` and publish the release with the changelog entry.
