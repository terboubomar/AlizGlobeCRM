---
name: arabic-rtl-ui
description: Rules for any UI work in apps/web (Next.js staff console, public QR complaint form /q/[code], tracking page /track/[token]). Use when adding or changing pages, components, styles, copy, icons, logos or responsive layout.
---

# Arabic-first RTL UI

`DESIGN.md` at the repo root is the visual contract — read it before non-trivial UI changes. Also read `apps/web/AGENTS.md`: this Next.js version differs from training data, so check `node_modules/next/dist/docs/` before using a Next API you are unsure of.

## Basics

- Root layout sets `<html lang="ar" dir="rtl">`. All staff and customer copy is Arabic. Keep English only for technical identifiers.
- Font: Cairo, bundled locally via `@fontsource/cairo` (400/600/700/800). Never add Google Fonts or any external font/CDN request.
- Styles live in `apps/web/app/style.css`. Use its `:root` variables (`--burgundy`, `--ink`, `--paper`, `--cream`, `--border`, `--muted`, `--green`, `--amber`, `--red`) instead of new hex values. Add a variable if you truly need a new token.
- Spacing scale 4/8/12/16/24/32/40px. Radius: inputs 8, buttons 10, cards 15, public QR form 22.
- Body 14px, minimum 12px. Hit areas at least 44×44px. Visible keyboard focus. Respect `prefers-reduced-motion`.

## RTL specifics

- Use logical CSS properties (`margin-inline-start`, `padding-inline-end`, `inset-inline-start`, `text-align: start`) instead of left/right.
- Directional icons (arrows, chevrons, "back") must point the RTL way.
- Phone numbers, order refs, case numbers, codes and URLs: wrap in `dir="ltr"` (or `<bdi>`) so digits don't reorder.
- Long brand/branch names truncate with ellipsis; they must not push layout.

## Brand assets

- Logos are in `apps/web/public/logos/` and are original customer files. Never edit, recolor, crop, re-encode or replace them, and never tint brand art with group burgundy.
- Don't invent logos for brands that lack one; use `neutral.svg`.

## Status and data

- Never convey SLA/priority/status by color alone — always include the text label (labels come from `stateLabels`/`categoryLabels` in `packages/domain/src`).
- Demo/synthetic metrics must carry a visible demo badge.
- Tables scroll horizontally inside their container on small screens; the page itself must never scroll sideways.
- Style: "quiet command center" — no gradients for decoration, no nested cards, no bounce animations, no stock illustrations.

## Check before finishing

- Unit tests in `apps/web/tests/*.test.tsx` (`npm run test:web`).
- Look at the page at 1440×900, 1024×768, 390×844 and 360×780 (the Playwright projects in `playwright.config.ts`). The public form at 360px must have no horizontal overflow.
- Permissions shown in the UI (`apps/web/app/access.ts`) are convenience only; the API must enforce them too.
