# Brand assets

A deployment's look comes from these files and `APP_NAME` in `wrangler.jsonc`. Replace them to rebrand.

- `logo.svg`: header logo, shown up to 194px wide. Keep the 1324 × 137 proportions or update `DeckBrand.tsx`.
- `logo-stacked.svg`, `logo-stacked-dark.svg`: the stacked logo for light and dark backgrounds, used at the top of the repo README. The app doesn't load them.
- `watermark.svg`: the stacked logo in one flat mid grey that reads on both themes. Shown faint at the bottom of the sidebar, in the empty reading pane and on the 404 page.
- `app-icon.svg`, `app-icon-192.png`, `app-icon-512.png`, `app-icon-maskable-512.png`: installed app icons, listed in `/site.webmanifest`. The maskable one keeps the mark inside Android's safe zone.
- `og-image.png` (1200 × 630): the link preview card.
- `/favicon.svg`, `/favicon.ico` (16, 32, 48 px) and `/apple-touch-icon.png` (180 px) in `public/`.
