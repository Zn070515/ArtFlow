# ADR-0016: Web shell and public Portal

- **Status**: accepted
- **Date**: 2026-10-26

## Decision

`apps/web` is the v2 product shell: React 19 + Vite 8 + TanStack Router/Query.
M8a ships the anonymous public results journey only. The page consumes the single
selector `GET /api/public/results/:publicCode`; it never reads editorial fields,
fingerprints, hashes, tokens, or staff data.

The visual direction is **Afterglow**: a deep-ink WebGL backdrop with a
domain-warped FBM aurora, pointer spotlight, film grain, and a procedural chrome
ring. The scene is a lazy-loaded chunk so the text and results render before
three.js is parsed. `prefers-reduced-motion` renders a static CSS backdrop and
never creates a WebGL context; a scene error boundary falls back to the same
backdrop. DPR is capped at 2 and the animation pauses while the tab is hidden.

In development and preview, Vite proxies `/api` to `VITE_API_TARGET`, keeping the
browser same-origin. Production web-process composition and entry switching are
deliberately deferred to M8e.

The E2E journey uses a dedicated schema (`artflow_e2e`) seeded by
`apps/api/scripts/seed-public-result.ts`; the Playwright configuration starts the
API and web dev server itself. The Gates workflow has a separate `web-e2e` job
with Chromium.

## Alternatives rejected

- Server-side rendering now: the public page is shareable, but SSR belongs with
  the M8e deployment/cutover decision; M8a keeps the slice small.
- A component library or CSS framework: the page is small and needs a bespoke
  visual language; bespoke CSS tokens avoid a second design system.
- A heavy glTF trophy: a procedural ring keeps the shader chunk smaller and
  avoids asset licensing/compression work.
