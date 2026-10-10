# Agents Go Postal design

Agents Go Postal is a compact mail workspace with brushed titanium surfaces and graphite navigation. Treat it as a useful instrument: mail content comes first, and the deployment's logo provides the color and personality.

- Use `/brand/logo.svg` in the upper left, including the mobile top bar. Keep its proportions intact. It may be smaller, never clipped.
- Use the app icon sparingly in empty states; retain the favicon and installed app metadata.
- Use Oxanium for headings and Space Grotesk for interface text. Keep email HTML isolated in its existing sandbox.
- Use `--chassis-surface`, `--silver-surface`, and `--titanium-surface` for metal. Graphite panels anchor navigation and folder headings. White and cool gray surfaces keep messages readable.
- The single global radius rule is 6px. Do not add component radius overrides; the logo image is exempt (`.deck-brand-logo`, enforced by `tests/design-rules.test.mjs`).
- Keep the frame within 6px of the viewport, the desktop header near 54px, and the source list (navigation) 194px wide. Avoid decorative cards or oversized headers.
- Primary actions use light text on graphite; ordinary controls use dark text on satin metal. Retain visible keyboard focus, active states, and disabled states.
- Mobile uses one content pane, an accessible hidden navigation drawer, and 44px controls for coarse pointers. Editable text is at least 16px to avoid iOS zoom.
- Tablet readers replace the list when there is insufficient space. Keep a visible Back control. Agent tools overlay at intermediate widths instead of compressing the reader.
- Preserve the Address filter, filtering, refresh, compose, drafts, reply/all/forward, stars, moves to system folders and labels, search, settings, attachments, source view, and agent/MCP behavior.
- No accent stripes or edge bars. Rows, cards, nav items, callouts and panels never use a colored or 2px-or-thicker one-sided border, a one-sided inset or hard box-shadow bar, a `::before` or `::after` bar, or a gradient on one edge. Selected, active and unread state is shown with fill, text weight, a full-perimeter ring, an icon or glyph, or inverse colors. Nesting is shown by indentation only. Quoted-reply text uses a fill or a full 1px box, not a left bar. Allowed: 1px neutral dividers between regions, the 1px white top highlight on metal controls, 4px square glyphs, blurred drop shadows, and stripes inside `/brand` artwork. Third-party message HTML inside the sandbox is not rewritten. Enforced by `tests/design-rules.test.mjs`.
- One list serves every address (`MAIL_UI=unified`). The address is a filter, not a mailbox: the Address popover has type-ahead, a Pinned group, domain groups with indented one-line address rows, and conversation counts. Filters are chips in a drill path that the LCD shows; each step backs out to that level. Never use Kumo `Collapsible` in navigation: it draws a left bar. The classic per-mailbox directory remains under `MAIL_UI=classic`.

Validation: `npm test`, `npm run typecheck`, and `npm run build`. The isolated preview requires explicit Tailwind app sources and must be rebuilt after the production build, which clears the build directory.
