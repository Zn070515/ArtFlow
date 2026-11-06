# ADR-0034: Split the public Portal and the operations Console shells

- Status: proposed (direction fixed 2026-10-27; implementation in the next frontend round)
- Date: 2026-10-27
- Related: ADR-0016, ADR-0002

## Context

Afterglow was designed for the anonymous public result journey (ADR-0016): a deep-ink
WebGL backdrop, a champagne-gold palette, display serif typography, and a
single centered hero. Later slices reused the same `RootLayout` for Ops, Studio,
Live, Judge, and Join without defining an operations shell.

The result is visible in the current UI:

- internal pages use the public `results-title` (up to 6.4rem) as their page title;
- every route mounts the full-screen WebGL scene, including forms and tables;
- glass cards with 26px blur and 30/90 shadows are used for dense operational cards;
- only 720px and 900px layout breakpoints exist;
- nine class names used by components are not defined in CSS (`voting-new`,
  `voting-sessions`, `button-primary`, etc.), producing default browser controls and
  overlapping controls on desktop;
- the header is a row of 12.5px text links with no active section, sidebar, or
  activity context.

The brand direction is not the problem. The problem is that a public-facing visual
language is being used as the product shell.

## Decision

Split the web application into two shells that share brand tokens only:

1. **Portal shell** (`/`, `/results/*`, `/vote/*`) keeps Afterglow: WebGL on the
   landing and result pages, static backdrop on vote, large serif hero, result
   choreography. Vote becomes a two-column desktop page.
2. **Console shell** (`/ops/*`, `/studio/*`, `/live/*`, `/judge/*`, `/join/*`,
   login) uses a product layout: 56px topbar, 240px sidebar, 1440px content grid,
   main column + 360px sticky rail, neutral surfaces, 1px borders, 10px radii,
   24–28px page titles, 14–15px body, 12px labels, no WebGL, no infinite animation.

The full specification, page-by-page layouts, token scale, component contract and
acceptance gates live in
[`docs/artflow-plus/frontend-design-direction.md`](../../artflow-plus/frontend-design-direction.md).

## Consequences

- The public Portal remains the brand expression; the Console becomes a dense,
  predictable workspace. There is no second color system.
- Console routes stop loading the three.js chunk. Reduced-motion remains supported
  in the Portal.
- Ops, Studio, Live, Judge and Join must be migrated page by page; `results-title`
  and other Portal-only styles are not allowed in Console.
- Components must use shared primitives; undefined class names and bare controls
  become a gate failure.
- The migration is visual and structural, not a product behavior change. API,
  authority, and E2E business journeys remain untouched.

## Verification

- No Console route mounts `AuroraScene`.
- Ops/Studio/Live desktop layouts have no auto-placement holes and use a sticky rail.
- Class coverage test, layout assertions and visual regression at 1440/1024/390.
- Public Portal still renders Afterglow and passes its reduced-motion test.
