# Agents Go Postal design

Agents Go Postal has one mail view, the postal view, described here. The settings pages (`/settings` for labels, `/settings/index` for the mail index) keep the older brushed-metal look; their rules are at the end.

## Postal

A dark, quiet workspace for many addresses on many domains. Mail content comes first; colour is spent on identity (which address and domain), state (unread, selected) and the agent.

### Tokens

- Tokens live on `.postal` in `app/index.css`, for a dark theme (default) and a real light theme (`data-theme="light"`), not a CSS invert. Components in `app/components/postal/postal.css` read only these variables.
- Dark neutrals: base `#141518`, sidebar and rails `#121316`, raised `#1c1d21`, modal `#16171a`, input `#17181b`, hover `#1f2025` on base and `#24262b` on raised, dividers `#26282d` and `#2a2c31`.
- Text, brightest to faintest: `#f0f0ed`, `#e4e4e1`, `#d5d5d2`, `#c9c9c5`, `#a3a4a0`, `#8b8d93`, `#7f8187`, `#6f7177`. `#7f8187` is the faintest colour allowed for body text (4.5:1). Fainter values are for glyphs, separators and placeholders.
- Accents, each with one job: mailbox blue `oklch(0.8 0.11 250)` (selection, focus, the tray icon), agent green `oklch(0.78 0.14 150)` (anything the agent does), amber `oklch(0.82 0.13 75)` (stars, warnings, search highlights), danger `oklch(0.62 0.17 25)` (log out).
- Type: Space Grotesk for the interface, JetBrains Mono for metadata: dates, addresses, counts, captions and key hints. Sizes 10, 11, 12, 13, 15 and 22px. Oxanium is not used in this view.
- Icons: Phosphor at 10, 12, 14 and 16px, 20px in empty states.
- Scrollbars are 7px and square: `oklch(0.4 0.035 250)`, brighter on hover, mailbox blue while dragged. The sidebar reserves a stable gutter.

### Radius

One radius: 6px, from the global rule in `app/index.css`. The exceptions, enforced by `tests/design-rules.test.mjs`:

- Circles (`50%`): switch knobs and the agent's activity dot. Round is reserved for the agent and controls; domains never use it.
- 2px: domain swatches and search-highlight marks.
- 0: scrollbar thumbs, the full-screen mobile composer, and the logo.
- Split controls may square their inner corners (`6px 0 0 6px`).

### Domain identity

Each domain gets a hue and a shape, derived from its position in `DOMAINS`: square, diamond, triangle, hexagon, repeating with a shifted hue after four. Shapes are drawn with `clip-path` (`.pg-shape-*`) so colour-blind readers can tell domains apart. Shapes are never round.

An address always renders as **bold handle**, muted `@`, then the domain in its hue (`AddressText` in `identity.tsx`). Use it everywhere an address appears: sidebar, list rows, reader, From pickers, search suggestions and settings.

### Layout

- Left column 236px (collapses to a 52px rail), centre, and the agent column 328px (collapses to a 44px "AGENT" rail). Both rail states persist per browser.
- Every column starts with a 38px header bar on one line: ALL ADDRESSES, the search bar, AGENT.
- The logo is a faint, tilted watermark at the right end of the search bar. There is no top-left logo.
- The list column is `clamp(280px, 30vw, 430px)`. Nothing may overflow at 280px.
- At 1100 to 1300px the left column starts as its rail and opens as an overlay; the agent panel overlays the reader.
- At 600px and below: one pane at a time with a Back control, the left column as a drawer, the agent as a bottom sheet, the composer full screen, 44px targets and 16px inputs.

### State

- Unread: a lifted row fill (`#191a1e`) plus bright, bold text. Read rows are dimmed.
- Current row: fill plus a full 1px ring. Checked rows: a blue tint plus a full 1px blue ring.
- Active nav item: fill, bright text, weight 600. A selected address only brightens; its folder carries the fill.
- Days are separated by a 10px dark band, not a heading.
- Key hints (`/`, `Z`, `⌘J`) can be hidden in Settings; shortcuts keep working.
- Tooltips: one layer (`Tooltip.tsx`) serves every button. Write a `title` as `Label (Key) · hint`; the key renders as keycaps and the hint as a muted second line. The browser's own tooltip never shows. Tooltips open after 450ms, then instantly while moving between buttons, and on keyboard focus. Touch never shows them. A button whose text already says everything gets none.

### No accent stripes or edge bars

This rule applies to every view. Rows, cards, nav items, callouts and panels never use a coloured or 2px-or-thicker one-sided border, a one-sided inset or hard box-shadow bar, a `::before` or `::after` bar, or a gradient on one edge. Selected, active and unread state is shown with fill, text weight, a full-perimeter ring, an icon or glyph, or inverse colours. Nesting is shown by indentation only. Quoted text uses a fill or a full 1px box, not a left bar. Allowed: 1px neutral dividers between regions, the 1px white top highlight on controls, square glyphs, blurred drop shadows, and stripes inside `/brand` artwork. Third-party message HTML inside the sandbox is not rewritten. Enforced by `tests/design-rules.test.mjs`.

### Message HTML

The reader reads like a mail client: subject, then a sender row with a 36px square initial avatar (coloured from the address; round stays reserved for the agent), name, address and date, and a "to" line naming the receiving address with its domain swatch.

Mail renders in the sandboxed iframe. Plain mail (no tables, images, colours or backgrounds of its own, see `isPlainHtml`) takes the reader's text colours on the reader surface, indented under the sender's name. Designed HTML mail keeps its white page inside a 1px-bordered card; on mobile the card runs edge to edge. Text-only bodies keep their line breaks. Remote images are blocked until the reader allows them (Settings: Ask, Always, Never).

## Settings pages

`/settings` and `/settings/index` keep the brushed titanium and graphite look.

- Use `/brand/logo.svg` in the upper left, including the mobile top bar. Keep its proportions intact. It may be smaller, never clipped.
- Use Oxanium for headings and Space Grotesk for interface text.
- Use `--chassis-surface`, `--silver-surface`, and `--titanium-surface` for metal. Graphite panels anchor navigation and folder headings.
- The single global radius rule is 6px; the logo image is exempt (`.deck-brand-logo`).

Validation: `npm test`, `npm run typecheck`, and `npm run build`.
