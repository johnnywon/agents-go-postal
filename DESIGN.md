# Agents Go Postal design

Agents Go Postal has one mail view, the postal view, described here. Everything else opens over it: Settings as a dialog, errors as a page in the same look.

## Postal

A dark, quiet workspace for many addresses on many domains. Mail content comes first; colour is spent on identity (which address and domain), state (unread, selected) and the agent.

### Tokens

- Tokens live on `.postal` in `app/index.css`, for a dark theme (default) and a real light theme (`data-theme="light"`), not a CSS invert. Components in `app/components/postal/postal.css` read only these variables.
- Dark neutrals: base `#141518`, sidebar and rails `#121316`, raised `#1c1d21`, modal `#16171a`, input `#17181b`, hover `#1f2025` on base and `#24262b` on raised, dividers `#26282d` and `#2a2c31`.
- Text, brightest to faintest: `#f0f0ed`, `#e4e4e1`, `#d5d5d2`, `#c9c9c5`, `#a3a4a0`, `#8b8d93`, `#7f8187`, `#6f7177`. `#7f8187` is the faintest colour allowed for body text (4.5:1). Fainter values are for glyphs, separators and placeholders.
- Accents, each with one job, taken from the logo (orange threads are mail, green cursors are the agent): mail orange `oklch(0.76 0.16 58)` (selection, focus, the accent in the mail nav icons), agent green `oklch(0.82 0.17 152)` (anything the agent does, the robot's eyes), yellow `oklch(0.87 0.15 95)` (stars, warnings, search highlights), danger rose `oklch(0.64 0.19 15)` (log out). Blue is not an accent; it stays only as the cool cast in the neutrals and for links.
- Type: Space Grotesk for the interface, JetBrains Mono for metadata: dates, addresses, counts, captions and key hints. Sizes 10, 11, 12, 13, 15 and 22px. Oxanium is not used in this view.
- Icons: Phosphor at 10, 12, 14 and 16px, 20px in empty states.
- Navigation icons are drawn like the robot, in `NavIcons.tsx`: a 24 grid with a 20px live area, 2px round strokes, 3px corners on bodies and 1.5 on small parts. Mail icons (All addresses, Inbox, Unread, By address, Drafts) carry one solid mail-orange accent, the robot's eye block where it fits; folder icons and Labels stay plain. By address runs 28 wide so the cursor block can follow the @.
- The agent is always the robot (`AgentIcon`): a rounded head, green cursor eyes, an @ on the antenna. The shell takes the surrounding colour; the eyes stay green. Use it at 14px or larger so the @ reads.
- Scrollbars are 7px and square: `oklch(0.4 0.035 250)`, brighter on hover, mail orange while dragged. The sidebar reserves a stable gutter.

### Radius

One radius: 6px, from the global rule in `app/index.css`. The exceptions, enforced by `tests/design-rules.test.mjs`:

- Circles (`50%`): switch knobs and the agent's activity dot.
- Pills: the switch track, 36×20 with a 10px radius, holding a 14px knob 3px in from each edge. Round is reserved for the agent and controls; domains never use it.
- 2px: domain swatches and search-highlight marks.
- 0: scrollbar thumbs, the full-screen mobile composer, the logo, and anything with a border on one side only (row and table dividers, headers, footers, the side columns). A radius would curl a divider's ends, and dividers are straight. The `.postal :is(...)` rule near the top of `postal.css` lists them, and the design test fails when a new one is missing.
- Split controls may square their inner corners (`6px 0 0 6px`).

### Domain identity

Each domain gets a hue and a shape, derived from its position in `DOMAINS`: square, diamond, triangle, hexagon, repeating with a shifted hue after four. Shapes are drawn with `clip-path` (`.pg-shape-*`) so colour-blind readers can tell domains apart. Shapes are never round.

An address always renders as **bold handle**, muted `@`, then the domain in its hue (`AddressText` in `identity.tsx`). Use it everywhere an address appears: sidebar, list rows, reader, From pickers, search suggestions and settings.

### Layout

- Left column 236px (collapses to a 52px rail), centre, and the agent column 328px (collapses to a 44px "AGENT" rail). Both rail states persist per browser.
- Every column starts with a 38px header bar on one line: ALL ADDRESSES, the search bar, AGENT.
- The logo is a faint background watermark at the bottom left, just above Settings: flat monochrome grey, no accent colours. It sits behind the expanded nav and takes no space. The collapsed rail has no logo, and there is no top-left logo.
- The list column is `clamp(280px, 30vw, 430px)`. Nothing may overflow at 280px.
- At 1100 to 1300px the left column starts as its rail and opens as an overlay; the agent panel overlays the reader.
- At 600px and below: one pane at a time with a Back control, the left column as a drawer, the agent as a bottom sheet, the composer full screen, 44px targets and 16px inputs.

### State

- Unread: a lifted row fill (`#191a1e`) plus bright, bold text. Read rows are dimmed.
- Current row: fill plus a full 1px ring. Checked rows: an orange tint plus a full 1px orange ring.
- Active nav item: fill, bright text, weight 600. A selected address only brightens; its folder carries the fill.
- Days are separated by a 10px dark band, not a heading.
- Key hints (`/`, `Z`, `⌘J`) can be hidden in Settings; shortcuts keep working.
- Tooltips: one layer (`Tooltip.tsx`) serves every button. Write a `title` as `Label (Key) · hint`; the key renders as keycaps and the hint as a muted second line. The browser's own tooltip never shows. Tooltips open after 450ms, then instantly while moving between buttons, and on keyboard focus. Touch never shows them. A button whose text already says everything gets none.

### No accent stripes or edge bars

This rule applies to every view. Rows, cards, nav items, callouts and panels never use a coloured or 2px-or-thicker one-sided border, a one-sided inset or hard box-shadow bar, a `::before` or `::after` bar, or a gradient on one edge. Selected, active and unread state is shown with fill, text weight, a full-perimeter ring, an icon or glyph, or inverse colours. Nesting is shown by indentation only. Quoted text uses a fill or a full 1px box, not a left bar. Allowed: 1px neutral dividers between regions, the 1px white top highlight on controls, square glyphs, blurred drop shadows, and stripes inside `/brand` artwork. Third-party message HTML inside the sandbox is not rewritten. Enforced by `tests/design-rules.test.mjs`.

### Message HTML

The reader reads like a mail client: subject, then a sender row with a 36px square initial avatar (coloured from the address; round stays reserved for the agent), name, address and date, and a "to" line naming the receiving address with its domain swatch.

Mail renders in the sandboxed iframe. Plain mail (no tables, images, colours or backgrounds of its own, see `isPlainHtml`) takes the reader's text colours on the reader surface, indented under the sender's name. Designed HTML mail keeps its white page inside a 1px-bordered card; on mobile the card runs edge to edge. Text-only bodies keep their line breaks. Remote images are blocked until the reader allows them (Settings: Ask, Always, Never).

### Settings

Settings is a dialog over the mail, with tabs: General, Addresses, Signatures, Labels, Agent, Model & key, Storage. The open tab is in the URL (`?settings=labels`), so a link opens it and Back closes it; `/settings` and `/settings/index` redirect to the Labels and Storage tabs. Most tabs save with Save changes. Labels and Storage act at once and say so. Tables (`.pg-table`) use mono headers with no fill, right-aligned numbers at 13px with zeros dimmed, addresses in the short `AddressText` form, and a rose tint for rows that disagree. Model & key opens with a notice (`.pg-models-notice`): a green-tinted box with a shield, "No training on your mail. Zero retention on OpenRouter.", and why (free, unpriced and partner models and direct keys can't be connected), with links to Cloudflare's and OpenRouter's policies. It is the tab's one paragraph of explanation. Then two steps, and colour has one meaning each: a provider's hue appears only on its 8px square (`.pg-prov-mark`), green marks the chosen, recommended, connected or zero retention, yellow marks a missing key. Prices and context are plain numbers, never tinted. The first step shows the agent model in a card (name, Recommended, the provider square and maker, the mono id, a line on what happens to prompts there, context, price in / out, Test, Change model) and the two providers, Cloudflare and OpenRouter, each with a dot that fills with the provider's colour when connected, its status, its model count, Add key or Manage (which opens the key field in the row), and its data line (`.pg-prov-data`), green for zero retention, ending in a Policy link to the provider's own page. Data lines state only what that page states. Change model opens the second step in place: Back, a full-width search that also takes any paid model id, filters (All, the two providers, then Anthropic, OpenAI, Google and xAI on OpenRouter) with a sort menu, then the list. With nothing typed and All chosen, the picker shows the four suggested models as cards (`.pg-pick`, two columns, one below 640px), each with its role above the name (Recommended in green, Cheapest, Balanced, Best quality) and a green shield with "Zero retention" when it runs on OpenRouter; the chosen card has a green border and a check. The sort menu is hidden there. Below the cards, a Browse list has a row per provider and per maker. Each list opens with a mono column header (title, Context, $ per 1M in / out) that labels the numbers once, then the provider's data line once. Rows (`.pg-model-row`): a square check, the name with Recommended, a muted line of provider, maker, "No tools" and "Needs key" separated by dots, then context and price right-aligned in tabular figures, output price in the stronger colour. A typed id that matches nothing gets a dashed "Use" row with a provider menu; a free id says why it's refused. Picking a row returns to the first step; if its provider has no key, that provider's row opens, tinted yellow, and the card says the key is needed. Escape in the picker clears the search, then the filter, then goes back. Below 640px the card stacks, the column header keeps only its title, price sits beside the name with context under it, and the filters scroll sideways. Below 600px the dialog fills the screen and the tabs scroll sideways.

### Error pages

Every error the app shows uses one layout (`ErrorPage.tsx`): the postal surface and theme, the status code in mono, a 22px heading, one line, Back to mail (plus Reload when a retry can help), and below them a small, faint watermark (112px, the sidebar watermark's opacity). The 404 page, the root error boundary and the Worker's Access errors all use it; the Worker's version is static HTML in `workers/lib/error-page.ts` that follows the system theme. A developer stack trace shows only in dev builds. API clients still get plain text.

Validation: `npm test`, `npm run typecheck`, and `npm run build`.
