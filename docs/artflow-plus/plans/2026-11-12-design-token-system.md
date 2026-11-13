# Design Token and Responsive Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the audited 36-font-size / 16-gap / 25-padding / 8-radius frontend into a closed two-layer token system, add the first primitive components, and prove the foundation on the Ops activity list at 1440 / 1024 / 390.

**Architecture:** Add a primitive scale (`scale.css`), a primitive palette (`palette.css`), and three semantic themes (`themes.css`). Keep old pages working through a deliberately temporary `legacy-aliases.css`; migrate only the Ops list in this phase. Add `components/ui/` primitives with tests, a dev-only token sheet, and responsive table cards. Later plans migrate Studio, Live, Portal, and the remaining Ops detail pages.

**Tech Stack:** React 19, TypeScript strict ESM, TanStack Router, Vitest + Testing Library, Playwright, Vite 8, existing Fontsource packages.

**Spec:** `docs/artflow-plus/specs/2026-11-12-design-token-system-design.md`

---

## Scope of this plan

This is Phase 1 of the spec, not the whole migration.

In scope:

- closed type/space/radius/shadow/motion scales;
- three semantic themes (`paper`, `graphite`, `afterglow`);
- Console typography and reduced-motion base;
- theme switching on the Console shell;
- Button, Input, Textarea, Select, Badge, Card, Table, Toolbar, EmptyState, ErrorState;
- a dev-only token sheet;
- the Ops activity list migrated to the primitives;
- mobile card rows for that list;
- token-contract, theme-contrast, and responsive E2E gates.

Out of scope (follow-up plans):

- Studio, Live, Judge, Workspace, Portal, Join, Vote page migration;
- deleting `legacy-aliases.css` and the old `--gold`/`--bone`/`--ink` references in unmigrated files;
- loading Instrument Serif / Noto Serif SC only on Portal (Portal keeps its current fonts in this phase);
- pixel-perfect visual regression baselines for every page; this plan adds the token sheet baseline and layout assertions.

## File map

Create:

- `plus/apps/web/src/styles/scale.css`
- `plus/apps/web/src/styles/palette.css`
- `plus/apps/web/src/styles/themes.css`
- `plus/apps/web/src/styles/legacy-aliases.css`
- `plus/apps/web/src/styles/ui.css`
- `plus/apps/web/src/styles/token-contract.test.ts`
- `plus/apps/web/src/styles/theme-contrast.test.ts` (replace)
- `plus/apps/web/src/theme/ThemeProvider.tsx`
- `plus/apps/web/src/theme/ThemeProvider.test.tsx`
- `plus/apps/web/src/theme/ThemeToggle.tsx`
- `plus/apps/web/src/components/ui/Button.tsx`
- `plus/apps/web/src/components/ui/Button.test.tsx`
- `plus/apps/web/src/components/ui/Input.tsx`
- `plus/apps/web/src/components/ui/Input.test.tsx`
- `plus/apps/web/src/components/ui/Textarea.tsx`
- `plus/apps/web/src/components/ui/Select.tsx`
- `plus/apps/web/src/components/ui/form-controls.test.tsx`
- `plus/apps/web/src/components/ui/Badge.tsx`
- `plus/apps/web/src/components/ui/Card.tsx`
- `plus/apps/web/src/components/ui/display-primitives.test.tsx`
- `plus/apps/web/src/components/ui/Table.tsx`
- `plus/apps/web/src/components/ui/Toolbar.tsx`
- `plus/apps/web/src/components/ui/data-primitives.test.tsx`
- `plus/apps/web/src/components/ui/EmptyState.tsx`
- `plus/apps/web/src/components/ui/ErrorState.tsx`
- `plus/apps/web/src/components/ui/state-primitives.test.tsx`
- `plus/apps/web/src/routes/tokens.tsx`
- `plus/apps/web/src/routes/tokens.test.tsx`
- `plus/apps/web/e2e/ops-responsive.spec.ts`

Modify:

- `plus/apps/web/src/styles/tokens.css`
- `plus/apps/web/src/styles/base.css`
- `plus/apps/web/src/styles/global.css`
- `plus/apps/web/src/styles/theme.test.ts`
- `plus/apps/web/src/main.tsx`
- `plus/apps/web/src/components/shell/ConsoleShell.tsx`
- `plus/apps/web/src/components/shell/PortalShell.tsx`
- `plus/apps/web/src/components/shell/shell.test.tsx`
- `plus/apps/web/src/router.tsx`
- `plus/apps/web/src/routes/ops.tsx`
- `plus/apps/web/src/routes/ops.test.tsx`
- `plus/apps/web/src/styles/ops.css`

---

## Task 1: Closed primitive scale

**Files:**

- Create: `plus/apps/web/src/styles/scale.css`
- Create: `plus/apps/web/src/styles/token-contract.test.ts`
- Modify: `plus/apps/web/src/styles/tokens.css`

- [ ] **Step 1: Write the failing scale test**

Create `plus/apps/web/src/styles/token-contract.test.ts`:

```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const stylesDirectory = join(process.cwd(), "src", "styles");

async function readScale(): Promise<string> {
  return readFile(join(stylesDirectory, "scale.css"), "utf8");
}

describe("closed token scale", () => {
  it("declares exactly the eight type steps", async () => {
    const scale = await readScale();
    const expected = [
      ["--text-1", "12px"],
      ["--text-2", "14px"],
      ["--text-3", "16px"],
      ["--text-4", "20px"],
      ["--text-5", "24px"],
      ["--text-6", "32px"],
      ["--text-7", "48px"],
      ["--text-8", "64px"],
    ];
    for (const [name, value] of expected) {
      expect(scale).toContain(`${name}: ${value};`);
    }
  });

  it("declares exactly the eight space steps", async () => {
    const scale = await readScale();
    const expected = [
      ["--space-1", "4px"],
      ["--space-2", "8px"],
      ["--space-3", "12px"],
      ["--space-4", "16px"],
      ["--space-5", "24px"],
      ["--space-6", "32px"],
      ["--space-7", "48px"],
      ["--space-8", "64px"],
    ];
    for (const [name, value] of expected) {
      expect(scale).toContain(`${name}: ${value};`);
    }
  });

  it("declares the five radius steps plus pill", async () => {
    const scale = await readScale();
    for (const [name, value] of [
      ["--radius-1", "4px"],
      ["--radius-2", "6px"],
      ["--radius-3", "8px"],
      ["--radius-4", "12px"],
      ["--radius-5", "16px"],
      ["--radius-pill", "9999px"],
    ]) {
      expect(scale).toContain(`${name}: ${value};`);
    }
  });

  it("declares one fast and one base duration", async () => {
    const scale = await readScale();
    expect(scale).toContain("--duration-fast: 120ms;");
    expect(scale).toContain("--duration-base: 180ms;");
    expect(scale).toContain("--ease-out: cubic-bezier(.2,.8,.2,1);");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```powershell
pnpm -C plus --filter @artflow-plus/web exec vitest run src/styles/token-contract.test.ts
```

Expected: FAIL with `ENOENT` for `src/styles/scale.css`.

- [ ] **Step 3: Create the scale**

Create `plus/apps/web/src/styles/scale.css`:

```css
@layer tokens {
  :root {
    --text-1: 12px;
    --text-2: 14px;
    --text-3: 16px;
    --text-4: 20px;
    --text-5: 24px;
    --text-6: 32px;
    --text-7: 48px;
    --text-8: 64px;

    --leading-tight: 1.1;
    --leading-ui: 1.45;
    --leading-body: 1.65;

    --weight-regular: 400;
    --weight-medium: 500;
    --weight-semibold: 600;

    --space-1: 4px;
    --space-2: 8px;
    --space-3: 12px;
    --space-4: 16px;
    --space-5: 24px;
    --space-6: 32px;
    --space-7: 48px;
    --space-8: 64px;

    --radius-1: 4px;
    --radius-2: 6px;
    --radius-3: 8px;
    --radius-4: 12px;
    --radius-5: 16px;
    --radius-pill: 9999px;

    --shadow-hairline: inset 0 0 0 1px var(--color-line);
    --shadow-float: 0 16px 40px rgb(0 0 0 / 35%);

    --duration-fast: 120ms;
    --duration-base: 180ms;
    --ease-out: cubic-bezier(.2,.8,.2,1);

    --font-body: "Inter Variable", "Noto Sans SC Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
    --font-ui-display: var(--font-body);
    --font-display: "Instrument Serif", "Noto Serif SC Variable", Georgia, "Songti SC", serif;
    --font-mono: "JetBrains Mono Variable", ui-monospace, SFMono-Regular, Menlo, monospace;
    --text-hero: clamp(3rem, 7vw, 4rem);
  }
}
```

- [ ] **Step 4: Import the scale from the token entry**

Replace the contents of `plus/apps/web/src/styles/tokens.css` with:

```css
@layer tokens, base, components, utilities;

@import "./scale.css";
```

- [ ] **Step 5: Run the test to verify it passes**

Run:

```powershell
pnpm -C plus --filter @artflow-plus/web exec vitest run src/styles/token-contract.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```powershell
git add plus/apps/web/src/styles/scale.css plus/apps/web/src/styles/token-contract.test.ts plus/apps/web/src/styles/tokens.css
git commit -m "feat(web): add the closed design token scale"
```

---

## Task 2: Palette, themes, and contrast test

**Files:**

- Create: `plus/apps/web/src/styles/palette.css`
- Create: `plus/apps/web/src/styles/themes.css`
- Create: `plus/apps/web/src/styles/legacy-aliases.css`
- Modify: `plus/apps/web/src/styles/tokens.css`
- Modify: `plus/apps/web/src/styles/theme.test.ts`
- Replace: `plus/apps/web/src/styles/theme-contrast.test.ts`

- [ ] **Step 1: Write the failing contrast test**

Replace `plus/apps/web/src/styles/theme-contrast.test.ts` with:

```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const stylesDirectory = join(process.cwd(), "src", "styles");

type ThemeName = "paper" | "graphite" | "afterglow";

function declarations(css: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const match of css.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    map.set(match[1] ?? "", (match[2] ?? "").trim());
  }
  return map;
}

function themeBlock(css: string, theme: ThemeName): string {
  const selector = `[data-theme="${theme}"]`;
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`missing ${selector}`);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  if (open < 0 || close < 0) throw new Error(`unclosed ${selector}`);
  return css.slice(open + 1, close);
}

function resolve(name: string, local: Map<string, string>, global: Map<string, string>, depth = 0): string {
  if (depth > 10) throw new Error("var() cycle");
  const value = local.get(name) ?? global.get(name);
  if (value === undefined) throw new Error(`missing --${name}`);
  const alias = /^var\(--([a-z0-9-]+)\)$/i.exec(value);
  return alias === null ? value : resolve(alias[1] ?? "", local, global, depth + 1);
}

function hex(value: string, name: string): string {
  const match = /^#[0-9a-f]{6}$/i.exec(value);
  if (match === null) throw new Error(`--${name} is not a six-digit hex: ${value}`);
  return value;
}

function channel(value: number): number {
  const normalized = value / 255;
  return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function luminance(value: string): number {
  return 0.2126 * channel(Number.parseInt(value.slice(1, 3), 16)) +
    0.7152 * channel(Number.parseInt(value.slice(3, 5), 16)) +
    0.0722 * channel(Number.parseInt(value.slice(5, 7), 16));
}

function contrast(first: string, second: string): number {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

describe("theme contrast", () => {
  it.each<ThemeName>(["paper", "graphite", "afterglow"])("meets text and control contrast in %s", async (theme) => {
    const palette = declarations(await readFile(join(stylesDirectory, "palette.css"), "utf8"));
    const themes = await readFile(join(stylesDirectory, "themes.css"), "utf8");
    const local = declarations(themeBlock(themes, theme));
    const read = (name: string): string => hex(resolve(name, local, palette), name);

    const page = read("color-page");
    const surface = read("color-surface");
    const text = read("color-text");
    const muted = read("color-text-muted");
    const accent = read("color-accent");
    const accentContrast = read("color-accent-contrast");
    const focus = read("color-focus");
    const danger = read("color-danger");

    expect(contrast(text, page), `${theme}: text on page`).toBeGreaterThanOrEqual(4.5);
    expect(contrast(text, surface), `${theme}: text on surface`).toBeGreaterThanOrEqual(4.5);
    expect(contrast(muted, surface), `${theme}: muted on surface`).toBeGreaterThanOrEqual(4.5);
    expect(contrast(accent, surface), `${theme}: accent on surface`).toBeGreaterThanOrEqual(3);
    expect(contrast(accentContrast, accent), `${theme}: text on accent`).toBeGreaterThanOrEqual(4.5);
    expect(contrast(focus, surface), `${theme}: focus on surface`).toBeGreaterThanOrEqual(3);
    expect(contrast(danger, surface), `${theme}: danger on surface`).toBeGreaterThanOrEqual(4.5);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```powershell
pnpm -C plus --filter @artflow-plus/web exec vitest run src/styles/theme-contrast.test.ts
```

Expected: FAIL with `ENOENT` for `palette.css` or `themes.css`.

- [ ] **Step 3: Create the palette**

Create `plus/apps/web/src/styles/palette.css`:

```css
@layer tokens {
  :root {
    --p-neutral-0: #ffffff;
    --p-neutral-50: #fafafa;
    --p-neutral-100: #f5f5f7;
    --p-neutral-200: #e8e8ed;
    --p-neutral-250: #e0e0e0;
    --p-neutral-300: #d2d2d7;
    --p-neutral-400: #a1a1a6;
    --p-neutral-500: #6e6e73;
    --p-neutral-600: #3a3a3c;
    --p-neutral-700: #1d1d1f;
    --p-neutral-800: #111113;
    --p-neutral-900: #08080a;

    --p-graphite-50: #f1f3f5;
    --p-graphite-100: #c9ced6;
    --p-graphite-200: #969ca6;
    --p-graphite-300: #7c828c;
    --p-graphite-400: #353941;
    --p-graphite-500: #24272e;
    --p-graphite-600: #1a1d23;
    --p-graphite-700: #15171c;
    --p-graphite-800: #101216;

    --p-ink-soft: #0d0d13;
    --p-ink-raised: #121218;
    --p-ink-hover: #1a1a22;
    --p-bone: #f5efe6;
    --p-bone-muted: #a5a19a;
    --p-bone-subtle: #918b82;
    --p-warm-500: #e8b45a;
    --p-warm-contrast: #160f05;

    --p-blue-400: #2997ff;
    --p-blue-500: #0066cc;
    --p-green-400: #7ddba2;
    --p-green-600: #1d7d34;
    --p-amber-400: #f4c96c;
    --p-amber-600: #b25000;
    --p-red-400: #ff927f;
    --p-red-600: #c50000;
    --p-cyan-400: #75c9ed;
  }
}
```

- [ ] **Step 4: Create the themes**

Create `plus/apps/web/src/styles/themes.css`:

```css
@layer tokens {
  [data-theme="paper"] {
    color-scheme: light;
    --color-page: var(--p-neutral-100);
    --color-surface: var(--p-neutral-0);
    --color-surface-raised: var(--p-neutral-50);
    --color-surface-hover: var(--p-neutral-200);
    --color-line: var(--p-neutral-250);
    --color-line-strong: var(--p-neutral-300);
    --color-text: var(--p-neutral-700);
    --color-text-muted: var(--p-neutral-500);
    --color-text-subtle: var(--p-neutral-500);
    --color-accent: var(--p-blue-500);
    --color-accent-contrast: var(--p-neutral-0);
    --color-focus: var(--p-blue-500);
    --color-success: var(--p-green-600);
    --color-warning: var(--p-amber-600);
    --color-danger: var(--p-red-600);
    --color-info: var(--p-blue-500);
    --color-neutral: var(--p-neutral-500);
  }

  [data-theme="graphite"] {
    color-scheme: dark;
    --color-page: var(--p-neutral-900);
    --color-surface: var(--p-graphite-800);
    --color-surface-raised: var(--p-graphite-700);
    --color-surface-hover: var(--p-graphite-600);
    --color-line: var(--p-graphite-500);
    --color-line-strong: var(--p-graphite-400);
    --color-text: var(--p-graphite-50);
    --color-text-muted: var(--p-graphite-200);
    --color-text-subtle: var(--p-graphite-300);
    --color-accent: var(--p-blue-400);
    --color-accent-contrast: var(--p-neutral-900);
    --color-focus: var(--p-blue-400);
    --color-success: var(--p-green-400);
    --color-warning: var(--p-amber-400);
    --color-danger: var(--p-red-400);
    --color-info: var(--p-cyan-400);
    --color-neutral: var(--p-graphite-200);
  }

  [data-theme="afterglow"] {
    color-scheme: dark;
    --color-page: var(--p-neutral-900);
    --color-surface: var(--p-ink-soft);
    --color-surface-raised: var(--p-ink-raised);
    --color-surface-hover: var(--p-ink-hover);
    --color-line: var(--p-graphite-500);
    --color-line-strong: var(--p-graphite-400);
    --color-text: var(--p-bone);
    --color-text-muted: var(--p-bone-muted);
    --color-text-subtle: var(--p-bone-subtle);
    --color-accent: var(--p-warm-500);
    --color-accent-contrast: var(--p-warm-contrast);
    --color-focus: var(--p-warm-500);
    --color-success: var(--p-green-400);
    --color-warning: #ffb37a;
    --color-danger: #ff9a76;
    --color-info: var(--p-cyan-400);
    --color-neutral: var(--p-bone-muted);
  }
}
```

- [ ] **Step 5: Add temporary compatibility aliases**

Create `plus/apps/web/src/styles/legacy-aliases.css`:

```css
/*
 * Deprecated: only for pages not yet migrated to semantic tokens.
 * Remove each alias when its last consumer is migrated.
 */
@layer tokens {
  :root {
    --ink: var(--color-page);
    --ink-soft: var(--color-surface);
    --bone: var(--color-text);
    --bone-dim: var(--color-text-muted);
    --bone-subtle: var(--color-text-subtle);
    --gold: var(--color-accent);
    --gold-bright: var(--color-accent);
    --gold-deep: var(--color-accent);
    --gold-soft: color-mix(in srgb, var(--color-accent) 16%, transparent);
    --accent-ink: var(--color-accent-contrast);
    --ember: var(--color-danger);
    --ember-soft: color-mix(in srgb, var(--color-danger) 24%, transparent);
    --cool: var(--color-info);
    --line: var(--color-line);
    --glass: var(--color-surface);
    --glass-strong: var(--color-surface-raised);
    --display: var(--font-display);
    --sans: var(--font-body);
    --radius: var(--radius-4);
    --shadow: var(--shadow-float);
  }

  [data-shell="console"] {
    --display: var(--font-ui-display);
    --sans: var(--font-body);
  }

  [data-shell="portal"] {
    --display: "Fraunces Variable", "Noto Serif SC", "Songti SC", "SimSun", serif;
    --sans: "Space Grotesk Variable", "Noto Sans SC", "Microsoft YaHei", sans-serif;
  }
}
```

- [ ] **Step 6: Import the new token files**

Replace the contents of `plus/apps/web/src/styles/tokens.css` with:

```css
@layer tokens, base, components, utilities;

@import "./scale.css";
@import "./palette.css";
@import "./themes.css";
@import "./legacy-aliases.css";
```

- [ ] **Step 7: Update the theme presence test**

Replace `plus/apps/web/src/styles/theme.test.ts` with:

```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readAllStyles } from "./read-styles.js";

const stylesDirectory = join(process.cwd(), "src", "styles");

describe("ArtFlow visual theme styles", () => {
  it("declares the paper, graphite and afterglow themes", async () => {
    const tokens = await readFile(`${stylesDirectory}/tokens.css`, "utf8");
    const themes = await readFile(`${stylesDirectory}/themes.css`, "utf8");
    const global = await readAllStyles(stylesDirectory);

    expect(tokens).toContain('"./themes.css"');
    expect(themes).toContain('[data-theme="paper"]');
    expect(themes).toContain('[data-theme="graphite"]');
    expect(themes).toContain('[data-theme="afterglow"]');
    expect(themes).toContain("--color-surface-raised");
    expect(global).toContain(".console-shell");
    expect(global).toContain(".console-table-wrap");
  });

  it("keeps Console surfaces opaque and avoids Portal-only blur", async () => {
    const global = await readAllStyles(stylesDirectory);
    const consoleCss = global.slice(global.indexOf(".console-shell"));

    expect(consoleCss).not.toContain("backdrop-filter: blur");
    expect(consoleCss).not.toContain("color: var(--ink)");
    expect(consoleCss).not.toContain("rgba(232, 180, 90");
    expect(consoleCss).toContain("min-height: 100vh");
  });

  it("keeps Console styling on semantic tokens", async () => {
    const global = await readAllStyles(stylesDirectory);

    expect(global).not.toContain("var(--muted, #666)");
    expect(global).not.toContain("var(--line, #ddd)");
    expect(global).toContain("font-variant-numeric: tabular-nums");
    expect(global).toContain("var(--color-focus)");
  });

  it("removes keyboard reachability from a closed mobile sidebar", async () => {
    const global = await readAllStyles(stylesDirectory);

    expect(global).toContain("visibility: hidden");
    expect(global).toContain("pointer-events: none");
    expect(global).toContain(".console-sidebar.is-open");
    expect(global).toContain("visibility: visible");
  });
});
```

- [ ] **Step 8: Run both style tests**

Run:

```powershell
pnpm -C plus --filter @artflow-plus/web exec vitest run src/styles/token-contract.test.ts src/styles/theme-contrast.test.ts src/styles/theme.test.ts
```

Expected: PASS. If a contrast assertion fails, adjust the named palette value, not the threshold.

- [ ] **Step 9: Commit**

```powershell
git add plus/apps/web/src/styles/palette.css plus/apps/web/src/styles/themes.css plus/apps/web/src/styles/legacy-aliases.css plus/apps/web/src/styles/tokens.css plus/apps/web/src/styles/theme.test.ts plus/apps/web/src/styles/theme-contrast.test.ts
git commit -m "feat(web): add semantic themes and contrast gates"
```

---

## Task 3: Console typography, fonts, and reduced motion

**Files:**

- Modify: `plus/apps/web/src/main.tsx`
- Modify: `plus/apps/web/src/styles/base.css`
- Create: `plus/apps/web/src/styles/base.test.ts`

- [ ] **Step 1: Write the failing base test**

Create `plus/apps/web/src/styles/base.test.ts`:

```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const stylesDirectory = join(process.cwd(), "src", "styles");

describe("base typography", () => {
  it("uses semantic page, text and font tokens", async () => {
    const base = await readFile(join(stylesDirectory, "base.css"), "utf8");
    expect(base).toContain("background: var(--color-page);");
    expect(base).toContain("color: var(--color-text);");
    expect(base).toContain("font-family: var(--font-body);");
    expect(base).toContain("font-size: var(--text-3);");
    expect(base).toContain("line-height: var(--leading-body);");
  });

  it("honors reduced motion globally", async () => {
    const base = await readFile(join(stylesDirectory, "base.css"), "utf8");
    expect(base).toContain("@media (prefers-reduced-motion: reduce)");
    expect(base).toContain("transition-duration: .01ms !important;");
    expect(base).toContain("animation-duration: .01ms !important;");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```powershell
pnpm -C plus --filter @artflow-plus/web exec vitest run src/styles/base.test.ts
```

Expected: FAIL because `base.css` still uses `var(--ink)` and `var(--bone)`.

- [ ] **Step 3: Add the Console font imports**

Modify the top of `plus/apps/web/src/main.tsx`:

```tsx
import "@fontsource-variable/fraunces";
import "@fontsource-variable/space-grotesk";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "./styles/tokens.css";
import "./styles/global.css";
```

Keep the existing Fraunces/Space Grotesk imports for the not-yet-migrated Portal; the Portal migration removes them later.

- [ ] **Step 4: Rewrite the base body and motion rules**

Replace the top of `plus/apps/web/src/styles/base.css` through the `::selection` rule with:

```css
@layer base {
  *,
  *::before,
  *::after {
    box-sizing: border-box;
  }

  html,
  body,
  #root {
    min-height: 100%;
  }

  body {
    margin: 0;
    background: var(--color-page);
    color: var(--color-text);
    font-family: var(--font-body);
    font-size: var(--text-3);
    line-height: var(--leading-body);
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }

  a {
    color: inherit;
  }

  button,
  input,
  select,
  textarea {
    font: inherit;
  }

  ::selection {
    background: var(--color-accent);
    color: var(--color-accent-contrast);
  }

  :focus-visible {
    outline: 2px solid var(--color-focus);
    outline-offset: 2px;
  }

  @media (prefers-reduced-motion: reduce) {
    *,
    *::before,
    *::after {
      animation-duration: .01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: .01ms !important;
      scroll-behavior: auto !important;
    }
  }
}
```

Keep the existing `.sr-only`, `.app-shell`, `.aurora`, `.site-header`, `.brand`, `.nav-link`, `.site-main` rules below. Remove the old duplicate `body`, `a`, `button`, `input`, `::selection`, `:focus-visible` rules.

- [ ] **Step 5: Run the base test**

Run:

```powershell
pnpm -C plus --filter @artflow-plus/web exec vitest run src/styles/base.test.ts
```

Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```powershell
git add plus/apps/web/src/main.tsx plus/apps/web/src/styles/base.css plus/apps/web/src/styles/base.test.ts
git commit -m "feat(web): move the base layer onto semantic typography tokens"
```

---

## Task 4: Theme provider and shell theme switching

**Files:**

- Create: `plus/apps/web/src/theme/ThemeProvider.tsx`
- Create: `plus/apps/web/src/theme/ThemeProvider.test.tsx`
- Create: `plus/apps/web/src/theme/ThemeToggle.tsx`
- Modify: `plus/apps/web/src/main.tsx`
- Modify: `plus/apps/web/src/components/shell/ConsoleShell.tsx`
- Modify: `plus/apps/web/src/components/shell/PortalShell.tsx`
- Modify: `plus/apps/web/src/components/shell/shell.test.tsx`

- [ ] **Step 1: Write the failing provider test**

Create `plus/apps/web/src/theme/ThemeProvider.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { ThemeProvider, useTheme } from "./ThemeProvider.js";

function Probe() {
  const { theme, setTheme } = useTheme();
  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <button type="button" onClick={() => setTheme(theme === "paper" ? "graphite" : "paper")}>
        toggle
      </button>
    </div>
  );
}

describe("ThemeProvider", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("falls back to the provided default", () => {
    render(
      <ThemeProvider defaultTheme="graphite">
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId("theme")).toHaveTextContent("graphite");
  });

  it("persists a user choice", () => {
    render(
      <ThemeProvider defaultTheme="graphite">
        <Probe />
      </ThemeProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "toggle" }));
    expect(screen.getByTestId("theme")).toHaveTextContent("paper");
    expect(localStorage.getItem("artflow-theme")).toBe("paper");
  });

  it("ignores an invalid stored value", () => {
    localStorage.setItem("artflow-theme", "neon");
    render(
      <ThemeProvider defaultTheme="paper">
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId("theme")).toHaveTextContent("paper");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```powershell
pnpm -C plus --filter @artflow-plus/web exec vitest run src/theme/ThemeProvider.test.tsx
```

Expected: FAIL with a missing module.

- [ ] **Step 3: Implement the provider and toggle**

Create `plus/apps/web/src/theme/ThemeProvider.tsx`:

```tsx
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

export type ThemeName = "paper" | "graphite" | "afterglow";

const STORAGE_KEY = "artflow-theme";
const VALID_THEMES: readonly ThemeName[] = ["paper", "graphite", "afterglow"];

interface ThemeContextValue {
  readonly theme: ThemeName;
  readonly setTheme: (theme: ThemeName) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: "graphite",
  setTheme: () => undefined,
});

function readStoredTheme(fallback: ThemeName): ThemeName {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === "paper" || stored === "graphite" || stored === "afterglow" ? stored : fallback;
  } catch {
    return fallback;
  }
}

export function ThemeProvider({ children, defaultTheme = "graphite" }: {
  readonly children: ReactNode;
  readonly defaultTheme?: ThemeName;
}) {
  const [theme, setThemeState] = useState<ThemeName>(() => readStoredTheme(defaultTheme));
  const value = useMemo<ThemeContextValue>(() => ({
    theme,
    setTheme: (next) => {
      if (!VALID_THEMES.includes(next)) return;
      setThemeState(next);
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // Storage is optional; the in-memory theme still applies.
      }
    },
  }), [theme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
```

Create `plus/apps/web/src/theme/ThemeToggle.tsx`:

```tsx
import { useTheme } from "./ThemeProvider.js";

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const next = theme === "paper" ? "graphite" : "paper";
  return (
    <button
      type="button"
      className="console-account-link"
      onClick={() => setTheme(next)}
      aria-label={`切换到${next === "paper" ? "浅色" : "深色"}主题`}
    >
      {theme === "paper" ? "深色" : "浅色"}
    </button>
  );
}
```

- [ ] **Step 4: Wire the provider and shells**

Modify `plus/apps/web/src/main.tsx` so the render tree is:

```tsx
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider defaultTheme="graphite">
        <SessionProvider>
          <RouterProvider router={router} />
        </SessionProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
```

Add the import:

```tsx
import { ThemeProvider } from "./theme/ThemeProvider.js";
```

Modify `plus/apps/web/src/components/shell/ConsoleShell.tsx`:

```tsx
import { ThemeToggle } from "../../theme/ThemeToggle.js";
import { useTheme } from "../../theme/ThemeProvider.js";
```

Inside the component add `const { theme } = useTheme();` and change the shell element to:

```tsx
<div className="console-shell" data-shell="console" data-theme={theme}>
```

Add the toggle in the topbar actions, before the login/logout button:

```tsx
<ThemeToggle />
```

Modify `plus/apps/web/src/components/shell/PortalShell.tsx` line 16 to:

```tsx
<div className="app-shell" data-shell="portal" data-theme="afterglow">
```

- [ ] **Step 5: Update the shell test expectations**

In `plus/apps/web/src/components/shell/shell.test.tsx`:

- replace `[data-shell="console"][data-theme="signal"]` with `[data-shell="console"][data-theme="graphite"]`;
- replace the two `[data-theme="violet"]` selectors with `[data-theme="afterglow"]`.

The three changed assertions are:

```tsx
expect(document.querySelector('[data-shell="console"][data-theme="graphite"]')).not.toBeNull();
expect(document.querySelector('[data-shell="portal"][data-theme="afterglow"]')).not.toBeNull();
expect(document.querySelector('[data-theme="afterglow"]')).not.toBeNull();
```

- [ ] **Step 6: Run the theme and shell tests**

Run:

```powershell
pnpm -C plus --filter @artflow-plus/web exec vitest run src/theme/ThemeProvider.test.tsx src/components/shell/shell.test.tsx
```

Expected: PASS. If `localStorage` is unavailable in a test, the provider falls back to the default.

- [ ] **Step 7: Commit**

```powershell
git add plus/apps/web/src/theme/ThemeProvider.tsx plus/apps/web/src/theme/ThemeProvider.test.tsx plus/apps/web/src/theme/ThemeToggle.tsx plus/apps/web/src/main.tsx plus/apps/web/src/components/shell/ConsoleShell.tsx plus/apps/web/src/components/shell/PortalShell.tsx plus/apps/web/src/components/shell/shell.test.tsx
git commit -m "feat(web): add persisted theme switching to the Console shell"
```

---

## Task 5: Button primitive

**Files:**

- Create: `plus/apps/web/src/components/ui/Button.tsx`
- Create: `plus/apps/web/src/components/ui/Button.test.tsx`
- Create: `plus/apps/web/src/styles/ui.css`
- Modify: `plus/apps/web/src/styles/global.css`

- [ ] **Step 1: Write the failing Button test**

Create `plus/apps/web/src/components/ui/Button.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Button } from "./Button.js";

describe("Button", () => {
  it("renders the requested variant and size", () => {
    render(<Button variant="primary" size="sm">保存</Button>);
    const button = screen.getByRole("button", { name: "保存" });
    expect(button).toHaveClass("ui-button", "ui-button--primary", "ui-button--sm");
  });

  it("defaults to secondary and medium", () => {
    render(<Button>取消</Button>);
    expect(screen.getByRole("button", { name: "取消" })).toHaveClass("ui-button--secondary", "ui-button--md");
  });

  it("disables the button and exposes busy state while loading", () => {
    render(<Button loading>保存</Button>);
    const button = screen.getByRole("button", { name: "保存" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
  });

  it("keeps a caller className", () => {
    render(<Button className="custom">打开</Button>);
    expect(screen.getByRole("button", { name: "打开" })).toHaveClass("ui-button", "custom");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```powershell
pnpm -C plus --filter @artflow-plus/web exec vitest run src/components/ui/Button.test.tsx
```

Expected: FAIL with a missing module.

- [ ] **Step 3: Implement Button**

Create `plus/apps/web/src/components/ui/Button.tsx`:

```tsx
import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "icon";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly loading?: boolean;
  readonly children: ReactNode;
}

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  disabled,
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      className={["ui-button", `ui-button--${variant}`, `ui-button--${size}`, className].filter(Boolean).join(" ")}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <span className="ui-button__spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}
```

- [ ] **Step 4: Add the primitive styles**

Create `plus/apps/web/src/styles/ui.css`:

```css
@layer components {
  .ui-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    border: 1px solid transparent;
    border-radius: var(--radius-2);
    font-family: var(--font-body);
    font-size: var(--text-2);
    font-weight: var(--weight-medium);
    line-height: var(--leading-ui);
    cursor: pointer;
    transition: background var(--duration-fast) var(--ease-out),
      border-color var(--duration-fast) var(--ease-out),
      color var(--duration-fast) var(--ease-out),
      transform var(--duration-fast) var(--ease-out);
  }

  .ui-button--sm { height: 32px; padding: 0 var(--space-3); }
  .ui-button--md { height: 40px; padding: 0 var(--space-4); }
  .ui-button--primary { background: var(--color-accent); color: var(--color-accent-contrast); }
  .ui-button--secondary { background: var(--color-surface); color: var(--color-text); border-color: var(--color-line); }
  .ui-button--ghost { background: transparent; color: var(--color-text-muted); }
  .ui-button--danger { background: var(--color-surface); color: var(--color-danger); border-color: var(--color-danger); }
  .ui-button--icon { width: 40px; padding: 0; }

  .ui-button:hover:not(:disabled) { border-color: var(--color-line-strong); }
  .ui-button--primary:hover:not(:disabled) { background: var(--color-accent); filter: brightness(1.06); }
  .ui-button:active:not(:disabled) { transform: scale(.97); }
  .ui-button:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
  .ui-button:disabled { opacity: .55; cursor: not-allowed; }

  .ui-button__spinner {
    width: 14px;
    height: 14px;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: ui-spin .7s linear infinite;
  }

  @keyframes ui-spin { to { transform: rotate(360deg); } }
}
```

Add to `plus/apps/web/src/styles/global.css` after `workspace.css`:

```css
@import "./ui.css";
```

- [ ] **Step 5: Run the Button test**

Run:

```powershell
pnpm -C plus --filter @artflow-plus/web exec vitest run src/components/ui/Button.test.tsx
```

Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```powershell
git add plus/apps/web/src/components/ui/Button.tsx plus/apps/web/src/components/ui/Button.test.tsx plus/apps/web/src/styles/ui.css plus/apps/web/src/styles/global.css
git commit -m "feat(web): add the Button primitive"
```

---

## Task 6: Form primitives

**Files:**

- Create: `plus/apps/web/src/components/ui/Input.tsx`
- Create: `plus/apps/web/src/components/ui/Textarea.tsx`
- Create: `plus/apps/web/src/components/ui/Select.tsx`
- Create: `plus/apps/web/src/components/ui/form-controls.test.tsx`
- Modify: `plus/apps/web/src/styles/ui.css`

- [ ] **Step 1: Write the failing form-control test**

Create `plus/apps/web/src/components/ui/form-controls.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Input } from "./Input.js";
import { Select } from "./Select.js";
import { Textarea } from "./Textarea.js";

describe("form primitives", () => {
  it("associates an input label and error", () => {
    render(<Input label="活动名称" error="请输入名称" />);
    const input = screen.getByRole("textbox", { name: "活动名称" });
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("请输入名称");
    expect(screen.getByRole("alert")).toHaveTextContent("请输入名称");
  });

  it("renders a textarea with a label", () => {
    render(<Textarea label="备注" rows={3} />);
    expect(screen.getByRole("textbox", { name: "备注" })).toHaveClass("ui-textarea");
  });

  it("renders a select with its options", () => {
    render(
      <Select label="状态" defaultValue="draft">
        <option value="draft">草稿</option>
        <option value="active">进行中</option>
      </Select>,
    );
    const select = screen.getByRole("combobox", { name: "状态" });
    expect(select).toHaveClass("ui-select");
    expect(screen.getByRole("option", { name: "进行中" })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```powershell
pnpm -C plus --filter @artflow-plus/web exec vitest run src/components/ui/form-controls.test.tsx
```

Expected: FAIL with missing modules.

- [ ] **Step 3: Implement Input, Textarea, Select**

Create `plus/apps/web/src/components/ui/Input.tsx`:

```tsx
import { useId, type InputHTMLAttributes } from "react";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  readonly label: string;
  readonly error?: string;
  readonly hint?: string;
}

export function Input({ label, error, hint, id, className, ...rest }: InputProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const hintId = hint === undefined ? undefined : `${inputId}-hint`;
  const errorId = error === undefined ? undefined : `${inputId}-error`;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div className={["ui-field", error === undefined ? "" : "ui-field--error", className].filter(Boolean).join(" ")}>
      <label className="ui-field__label" htmlFor={inputId}>{label}</label>
      <input
        id={inputId}
        className="ui-input"
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={describedBy}
        {...rest}
      />
      {hint === undefined ? null : <p id={hintId} className="ui-field__hint">{hint}</p>}
      {error === undefined ? null : <p id={errorId} className="ui-field__error" role="alert">{error}</p>}
    </div>
  );
}
```

Create `plus/apps/web/src/components/ui/Textarea.tsx`:

```tsx
import { useId, type TextareaHTMLAttributes } from "react";

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  readonly label: string;
  readonly error?: string;
}

export function Textarea({ label, error, id, className, ...rest }: TextareaProps) {
  const generatedId = useId();
  const textareaId = id ?? generatedId;
  const errorId = error === undefined ? undefined : `${textareaId}-error`;

  return (
    <div className={["ui-field", error === undefined ? "" : "ui-field--error", className].filter(Boolean).join(" ")}>
      <label className="ui-field__label" htmlFor={textareaId}>{label}</label>
      <textarea
        id={textareaId}
        className="ui-textarea"
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={errorId}
        {...rest}
      />
      {error === undefined ? null : <p id={errorId} className="ui-field__error" role="alert">{error}</p>}
    </div>
  );
}
```

Create `plus/apps/web/src/components/ui/Select.tsx`:

```tsx
import { useId, type SelectHTMLAttributes, type ReactNode } from "react";

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  readonly label: string;
  readonly children: ReactNode;
}

export function Select({ label, children, id, className, ...rest }: SelectProps) {
  const generatedId = useId();
  const selectId = id ?? generatedId;

  return (
    <div className={["ui-field", className].filter(Boolean).join(" ")}>
      <label className="ui-field__label" htmlFor={selectId}>{label}</label>
      <select id={selectId} className="ui-select" {...rest}>
        {children}
      </select>
    </div>
  );
}
```

- [ ] **Step 4: Add the form styles**

Append to `plus/apps/web/src/styles/ui.css` inside the `@layer components` block:

```css
  .ui-field { display: flex; flex-direction: column; gap: var(--space-2); min-width: 0; }
  .ui-field__label { color: var(--color-text-muted); font-size: var(--text-1); font-weight: var(--weight-medium); line-height: var(--leading-ui); }
  .ui-field__hint { margin: 0; color: var(--color-text-subtle); font-size: var(--text-1); line-height: var(--leading-ui); }
  .ui-field__error { margin: 0; color: var(--color-danger); font-size: var(--text-1); line-height: var(--leading-ui); }

  .ui-input,
  .ui-textarea,
  .ui-select {
    width: 100%;
    min-height: 40px;
    padding: 0 var(--space-3);
    border: 1px solid var(--color-line);
    border-radius: var(--radius-2);
    background: var(--color-surface);
    color: var(--color-text);
    font-family: var(--font-body);
    font-size: var(--text-2);
    line-height: var(--leading-ui);
  }

  .ui-textarea { min-height: 96px; padding-top: var(--space-2); padding-bottom: var(--space-2); resize: vertical; }
  .ui-input:focus-visible,
  .ui-textarea:focus-visible,
  .ui-select:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 1px; border-color: var(--color-focus); }
  .ui-field--error .ui-input,
  .ui-field--error .ui-textarea,
  .ui-field--error .ui-select { border-color: var(--color-danger); }
  .ui-input:disabled,
  .ui-textarea:disabled,
  .ui-select:disabled { opacity: .55; cursor: not-allowed; }
```

- [ ] **Step 5: Run the form tests**

Run:

```powershell
pnpm -C plus --filter @artflow-plus/web exec vitest run src/components/ui/form-controls.test.tsx
```

Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```powershell
git add plus/apps/web/src/components/ui/Input.tsx plus/apps/web/src/components/ui/Textarea.tsx plus/apps/web/src/components/ui/Select.tsx plus/apps/web/src/components/ui/form-controls.test.tsx plus/apps/web/src/styles/ui.css
git commit -m "feat(web): add Input, Textarea and Select primitives"
```

---

## Task 7: Badge and Card primitives

**Files:**

- Create: `plus/apps/web/src/components/ui/Badge.tsx`
- Create: `plus/apps/web/src/components/ui/Card.tsx`
- Create: `plus/apps/web/src/components/ui/display-primitives.test.tsx`
- Modify: `plus/apps/web/src/styles/ui.css`

- [ ] **Step 1: Write the failing display test**

Create `plus/apps/web/src/components/ui/display-primitives.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Badge } from "./Badge.js";
import { Card, CardHeader } from "./Card.js";

describe("Badge and Card", () => {
  it("renders a badge with its tone and text", () => {
    render(<Badge tone="success">进行中</Badge>);
    const badge = screen.getByText("进行中");
    expect(badge).toHaveClass("ui-badge", "ui-badge--success");
  });

  it("renders a card header with an action", () => {
    render(
      <Card>
        <CardHeader title="活动摘要" description="3 个活动" actions={<button type="button">刷新</button>} />
        <p>内容</p>
      </Card>,
    );
    expect(screen.getByRole("heading", { name: "活动摘要" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "刷新" })).toBeInTheDocument();
    expect(screen.getByText("内容").closest(".ui-card")).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```powershell
pnpm -C plus --filter @artflow-plus/web exec vitest run src/components/ui/display-primitives.test.tsx
```

Expected: FAIL with missing modules.

- [ ] **Step 3: Implement Badge and Card**

Create `plus/apps/web/src/components/ui/Badge.tsx`:

```tsx
import type { ReactNode } from "react";

export type BadgeTone = "success" | "warning" | "danger" | "info" | "neutral";

export function Badge({ tone = "neutral", children }: {
  readonly tone?: BadgeTone;
  readonly children: ReactNode;
}) {
  return <span className={`ui-badge ui-badge--${tone}`}>{children}</span>;
}
```

Create `plus/apps/web/src/components/ui/Card.tsx`:

```tsx
import type { ReactNode } from "react";

export function Card({ children, className }: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return <section className={["ui-card", className].filter(Boolean).join(" ")}>{children}</section>;
}

export function CardHeader({ title, description, actions }: {
  readonly title: string;
  readonly description?: string;
  readonly actions?: ReactNode;
}) {
  return (
    <header className="ui-card__header">
      <div>
        <h2 className="ui-card__title">{title}</h2>
        {description === undefined ? null : <p className="ui-card__description">{description}</p>}
      </div>
      {actions === undefined ? null : <div className="ui-card__actions">{actions}</div>}
    </header>
  );
}
```

- [ ] **Step 4: Add the display styles**

Append to `plus/apps/web/src/styles/ui.css` inside `@layer components`:

```css
  .ui-badge {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    min-height: 24px;
    padding: 0 var(--space-2);
    border: 1px solid transparent;
    border-radius: var(--radius-pill);
    font-size: var(--text-1);
    font-weight: var(--weight-medium);
    line-height: var(--leading-ui);
    white-space: nowrap;
  }

  .ui-badge--success { background: color-mix(in srgb, var(--color-success) 14%, transparent); color: var(--color-success); }
  .ui-badge--warning { background: color-mix(in srgb, var(--color-warning) 14%, transparent); color: var(--color-warning); }
  .ui-badge--danger { background: color-mix(in srgb, var(--color-danger) 14%, transparent); color: var(--color-danger); }
  .ui-badge--info { background: color-mix(in srgb, var(--color-info) 14%, transparent); color: var(--color-info); }
  .ui-badge--neutral { background: var(--color-surface-raised); color: var(--color-text-muted); }

  .ui-card {
    border: 1px solid var(--color-line);
    border-radius: var(--radius-4);
    background: var(--color-surface);
    padding: var(--space-5);
  }

  .ui-card__header { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4); }
  .ui-card__title { margin: 0; font-size: var(--text-4); font-weight: var(--weight-semibold); line-height: var(--leading-tight); }
  .ui-card__description { margin: var(--space-1) 0 0; color: var(--color-text-muted); font-size: var(--text-2); line-height: var(--leading-ui); }
  .ui-card__actions { display: flex; align-items: center; gap: var(--space-2); }
```

- [ ] **Step 5: Run the display tests**

Run:

```powershell
pnpm -C plus --filter @artflow-plus/web exec vitest run src/components/ui/display-primitives.test.tsx
```

Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```powershell
git add plus/apps/web/src/components/ui/Badge.tsx plus/apps/web/src/components/ui/Card.tsx plus/apps/web/src/components/ui/display-primitives.test.tsx plus/apps/web/src/styles/ui.css
git commit -m "feat(web): add Badge and Card primitives"
```

---

## Task 8: Table and Toolbar primitives

**Files:**

- Create: `plus/apps/web/src/components/ui/Table.tsx`
- Create: `plus/apps/web/src/components/ui/Toolbar.tsx`
- Create: `plus/apps/web/src/components/ui/data-primitives.test.tsx`
- Modify: `plus/apps/web/src/styles/ui.css`

- [ ] **Step 1: Write the failing data test**

Create `plus/apps/web/src/components/ui/data-primitives.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Table } from "./Table.js";
import { Toolbar } from "./Toolbar.js";

describe("Table and Toolbar", () => {
  it("wraps a table in the overflow container and keeps an accessible caption", () => {
    render(
      <Table caption="活动列表">
        <thead><tr><th scope="col">活动</th></tr></thead>
        <tbody><tr><td data-label="活动">春季歌手赛</td></tr></tbody>
      </Table>,
    );
    expect(screen.getByRole("table", { name: "活动列表" })).toHaveClass("ui-table");
    expect(document.querySelector(".ui-table-wrap")).not.toBeNull();
  });

  it("renders a labelled toolbar", () => {
    render(<Toolbar label="活动筛选"><input aria-label="搜索" /></Toolbar>);
    expect(screen.getByRole("search", { name: "活动筛选" })).toHaveClass("ui-toolbar");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```powershell
pnpm -C plus --filter @artflow-plus/web exec vitest run src/components/ui/data-primitives.test.tsx
```

Expected: FAIL with missing modules.

- [ ] **Step 3: Implement Table and Toolbar**

Create `plus/apps/web/src/components/ui/Table.tsx`:

```tsx
import type { ReactNode } from "react";

export function Table({ caption, children, className }: {
  readonly caption: string;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <div className="ui-table-wrap">
      <table className={["ui-table", className].filter(Boolean).join(" ")}>
        <caption className="sr-only">{caption}</caption>
        {children}
      </table>
    </div>
  );
}
```

Create `plus/apps/web/src/components/ui/Toolbar.tsx`:

```tsx
import type { ReactNode } from "react";

export function Toolbar({ label, children, className }: {
  readonly label: string;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <div className={["ui-toolbar", className].filter(Boolean).join(" ")} role="search" aria-label={label}>
      {children}
    </div>
  );
}
```

- [ ] **Step 4: Add the data styles**

Append to `plus/apps/web/src/styles/ui.css` inside `@layer components`:

```css
  .ui-toolbar { display: flex; align-items: flex-end; flex-wrap: wrap; gap: var(--space-3); padding: var(--space-3) 0; }
  .ui-toolbar .ui-field { min-width: 200px; }
  .ui-table-wrap { overflow-x: auto; border: 1px solid var(--color-line); border-radius: var(--radius-3); background: var(--color-surface); }
  .ui-table { width: 100%; border-collapse: collapse; font-size: var(--text-2); line-height: var(--leading-ui); }
  .ui-table th { position: sticky; top: 0; z-index: 1; background: var(--color-surface); color: var(--color-text-muted); font-size: var(--text-1); font-weight: var(--weight-medium); text-align: left; white-space: nowrap; padding: var(--space-3); border-bottom: 1px solid var(--color-line); }
  .ui-table td { padding: var(--space-3); border-bottom: 1px solid var(--color-line); white-space: nowrap; }
  .ui-table tbody tr:last-child td { border-bottom: 0; }
  .ui-table tbody tr:hover td { background: var(--color-surface-hover); }
  .ui-table .ui-table__num { text-align: right; font-variant-numeric: tabular-nums; }
```

- [ ] **Step 5: Run the data tests**

Run:

```powershell
pnpm -C plus --filter @artflow-plus/web exec vitest run src/components/ui/data-primitives.test.tsx
```

Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```powershell
git add plus/apps/web/src/components/ui/Table.tsx plus/apps/web/src/components/ui/Toolbar.tsx plus/apps/web/src/components/ui/data-primitives.test.tsx plus/apps/web/src/styles/ui.css
git commit -m "feat(web): add Table and Toolbar primitives"
```

---

## Task 9: EmptyState and ErrorState primitives

**Files:**

- Create: `plus/apps/web/src/components/ui/EmptyState.tsx`
- Create: `plus/apps/web/src/components/ui/ErrorState.tsx`
- Create: `plus/apps/web/src/components/ui/state-primitives.test.tsx`
- Modify: `plus/apps/web/src/styles/ui.css`

- [ ] **Step 1: Write the failing state test**

Create `plus/apps/web/src/components/ui/state-primitives.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { EmptyState } from "./EmptyState.js";
import { ErrorState } from "./ErrorState.js";

describe("EmptyState and ErrorState", () => {
  it("renders an empty state with an action", () => {
    render(<EmptyState title="还没有活动" description="创建第一个活动后从这里开始。" action={<button type="button">新建活动</button>} />);
    expect(screen.getByRole("heading", { name: "还没有活动" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新建活动" })).toBeInTheDocument();
  });

  it("renders an error state and invokes retry", () => {
    const onRetry = vi.fn();
    render(<ErrorState description="活动列表暂时无法加载。" onRetry={onRetry} />);
    expect(screen.getByRole("alert")).toHaveTextContent("活动列表暂时无法加载。");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```powershell
pnpm -C plus --filter @artflow-plus/web exec vitest run src/components/ui/state-primitives.test.tsx
```

Expected: FAIL with missing modules.

- [ ] **Step 3: Implement the state primitives**

Create `plus/apps/web/src/components/ui/EmptyState.tsx`:

```tsx
import type { ReactNode } from "react";

export function EmptyState({ title, description, action }: {
  readonly title: string;
  readonly description?: string;
  readonly action?: ReactNode;
}) {
  return (
    <section className="ui-state">
      <h2 className="ui-state__title">{title}</h2>
      {description === undefined ? null : <p className="ui-state__copy">{description}</p>}
      {action === undefined ? null : <div className="ui-state__action">{action}</div>}
    </section>
  );
}
```

Create `plus/apps/web/src/components/ui/ErrorState.tsx`:

```tsx
import { Button } from "./Button.js";

export function ErrorState({ title = "暂时无法加载", description, onRetry }: {
  readonly title?: string;
  readonly description: string;
  readonly onRetry?: () => void;
}) {
  return (
    <section className="ui-state ui-state--error" role="alert">
      <h2 className="ui-state__title">{title}</h2>
      <p className="ui-state__copy">{description}</p>
      {onRetry === undefined ? null : (
        <div className="ui-state__action">
          <Button variant="secondary" onClick={onRetry}>重试</Button>
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 4: Add the state styles**

Append to `plus/apps/web/src/styles/ui.css` inside `@layer components`:

```css
  .ui-state { display: flex; flex-direction: column; align-items: flex-start; gap: var(--space-2); padding: var(--space-6); border: 1px dashed var(--color-line-strong); border-radius: var(--radius-4); background: var(--color-surface); }
  .ui-state--error { border-style: solid; border-color: var(--color-danger); }
  .ui-state__title { margin: 0; font-size: var(--text-4); font-weight: var(--weight-semibold); line-height: var(--leading-tight); }
  .ui-state__copy { margin: 0; color: var(--color-text-muted); font-size: var(--text-2); line-height: var(--leading-body); }
  .ui-state__action { margin-top: var(--space-2); }
```

- [ ] **Step 5: Run the state tests**

Run:

```powershell
pnpm -C plus --filter @artflow-plus/web exec vitest run src/components/ui/state-primitives.test.tsx
```

Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```powershell
git add plus/apps/web/src/components/ui/EmptyState.tsx plus/apps/web/src/components/ui/ErrorState.tsx plus/apps/web/src/components/ui/state-primitives.test.tsx plus/apps/web/src/styles/ui.css
git commit -m "feat(web): add EmptyState and ErrorState primitives"
```

---

## Task 10: Dev-only token sheet

**Files:**

- Create: `plus/apps/web/src/routes/tokens.tsx`
- Create: `plus/apps/web/src/routes/tokens.test.tsx`
- Modify: `plus/apps/web/src/router.tsx`
- Modify: `plus/apps/web/src/styles/ui.css`

- [ ] **Step 1: Write the failing token-sheet test**

Create `plus/apps/web/src/routes/tokens.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TokensPage } from "./tokens.js";

describe("TokensPage", () => {
  it("shows the scales, the three themes and the primitives", () => {
    render(<TokensPage />);
    expect(screen.getByRole("heading", { name: "设计 token" })).toBeInTheDocument();
    expect(screen.getByText("paper")).toBeInTheDocument();
    expect(screen.getByText("graphite")).toBeInTheDocument();
    expect(screen.getByText("afterglow")).toBeInTheDocument();
    expect(screen.getAllByRole("button").length).toBeGreaterThan(0);
    expect(screen.getByText("16px")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```powershell
pnpm -C plus --filter @artflow-plus/web exec vitest run src/routes/tokens.test.tsx
```

Expected: FAIL with a missing module.

- [ ] **Step 3: Implement the token sheet**

Create `plus/apps/web/src/routes/tokens.tsx`:

```tsx
import { Badge } from "../components/ui/Badge.js";
import { Button } from "../components/ui/Button.js";
import { Card, CardHeader } from "../components/ui/Card.js";
import { Input } from "../components/ui/Input.js";
import { Table } from "../components/ui/Table.js";

const TYPE_STEPS = [12, 14, 16, 20, 24, 32, 48, 64] as const;
const SPACE_STEPS = [4, 8, 12, 16, 24, 32, 48, 64] as const;
const THEMES = ["paper", "graphite", "afterglow"] as const;

export function TokensPage() {
  if (!import.meta.env.DEV) {
    return (
      <section className="ui-state">
        <h2 className="ui-state__title">Token sheet</h2>
        <p className="ui-state__copy">该页面只在开发环境可用。</p>
      </section>
    );
  }

  return (
    <article className="tokens-page">
      <header className="tokens-page__header">
        <h1>设计 token</h1>
        <p>8 级字阶、8 级间距、5 级圆角，以及三套主题下的 primitive。</p>
      </header>

      <section className="tokens-page__section" aria-labelledby="type-scale">
        <h2 id="type-scale">字阶</h2>
        <div className="tokens-page__type">
          {TYPE_STEPS.map((size) => (
            <p key={size} style={{ fontSize: `var(--text-${TYPE_STEPS.indexOf(size) + 1})` }}>
              {size}px · 春季歌手赛 ArtFlow 2026
            </p>
          ))}
        </div>
      </section>

      <section className="tokens-page__section" aria-labelledby="space-scale">
        <h2 id="space-scale">间距</h2>
        <div className="tokens-page__space">
          {SPACE_STEPS.map((size, index) => (
            <div key={size} className="tokens-page__space-row">
              <code>{`--space-${index + 1}`}</code>
              <span style={{ width: `var(--space-${index + 1})` }} />
              <small>{size}px</small>
            </div>
          ))}
        </div>
      </section>

      <section className="tokens-page__section" aria-labelledby="themes">
        <h2 id="themes">主题与 primitive</h2>
        <div className="tokens-page__themes">
          {THEMES.map((theme) => (
            <div key={theme} className="tokens-page__theme" data-theme={theme}>
              <h3>{theme}</h3>
              <div className="tokens-page__row">
                <Button variant="primary">主操作</Button>
                <Button variant="secondary">次操作</Button>
                <Button variant="ghost">文字</Button>
                <Button variant="danger">危险</Button>
              </div>
              <div className="tokens-page__row">
                <Badge tone="success">进行中</Badge>
                <Badge tone="warning">待审核</Badge>
                <Badge tone="danger">已拒绝</Badge>
                <Badge tone="neutral">已归档</Badge>
              </div>
              <Input label="活动名称" placeholder="春季歌手赛" />
              <Card>
                <CardHeader title="活动摘要" description="3 个活动 · 1 个需要处理" />
              </Card>
              <Table caption="示例表格">
                <thead><tr><th scope="col">活动</th><th scope="col" className="ui-table__num">报名</th></tr></thead>
                <tbody><tr><td data-label="活动">春季歌手赛</td><td data-label="报名" className="ui-table__num">48</td></tr></tbody>
              </Table>
            </div>
          ))}
        </div>
      </section>
    </article>
  );
}
```

Add to `plus/apps/web/src/styles/ui.css` inside `@layer components`:

```css
  .tokens-page { display: flex; flex-direction: column; gap: var(--space-7); padding: var(--space-7); }
  .tokens-page__header h1 { margin: 0; font-size: var(--text-6); font-weight: var(--weight-semibold); line-height: var(--leading-tight); }
  .tokens-page__header p { margin: var(--space-2) 0 0; color: var(--color-text-muted); }
  .tokens-page__section { display: flex; flex-direction: column; gap: var(--space-4); }
  .tokens-page__section h2 { margin: 0; font-size: var(--text-5); font-weight: var(--weight-semibold); }
  .tokens-page__type p { margin: 0; line-height: var(--leading-tight); }
  .tokens-page__space { display: flex; flex-direction: column; gap: var(--space-2); }
  .tokens-page__space-row { display: flex; align-items: center; gap: var(--space-3); }
  .tokens-page__space-row span { display: block; height: var(--space-2); background: var(--color-accent); }
  .tokens-page__themes { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-4); }
  .tokens-page__theme { display: flex; flex-direction: column; gap: var(--space-3); padding: var(--space-4); border-radius: var(--radius-4); background: var(--color-page); color: var(--color-text); }
  .tokens-page__theme h3 { margin: 0; font-size: var(--text-4); }
  .tokens-page__row { display: flex; flex-wrap: wrap; gap: var(--space-2); }
  @media (max-width: 1023px) { .tokens-page__themes { grid-template-columns: 1fr; } }
```

- [ ] **Step 4: Register the route**

In `plus/apps/web/src/router.tsx`:

1. add the import near the other route imports:

```tsx
import { TokensPage } from "./routes/tokens.js";
```

2. add the route before `routeTree`:

```tsx
const tokensRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/_tokens",
  component: TokensPage,
});
```

3. add `tokensRoute` to the `rootRoute.addChildren([...])` array.

- [ ] **Step 5: Run the token-sheet test and typecheck**

Run:

```powershell
pnpm -C plus --filter @artflow-plus/web exec vitest run src/routes/tokens.test.tsx
pnpm -C plus --filter @artflow-plus/web run check
```

Expected: test PASS; typecheck PASS.

- [ ] **Step 6: Commit**

```powershell
git add plus/apps/web/src/routes/tokens.tsx plus/apps/web/src/routes/tokens.test.tsx plus/apps/web/src/router.tsx plus/apps/web/src/styles/ui.css
git commit -m "feat(web): add the dev-only token sheet"
```

---

## Task 11: Migrate the Ops activity list

**Files:**

- Modify: `plus/apps/web/src/routes/ops.tsx`
- Modify: `plus/apps/web/src/routes/ops.test.tsx`
- Modify: `plus/apps/web/src/styles/ops.css`
- Modify: `plus/apps/web/src/styles/token-contract.test.ts`

- [ ] **Step 1: Write the failing migrated-surface test**

Append to `plus/apps/web/src/styles/token-contract.test.ts`:

```ts
const migratedFiles = [
  join(process.cwd(), "src", "components", "ui", "Button.tsx"),
  join(process.cwd(), "src", "components", "ui", "Input.tsx"),
  join(process.cwd(), "src", "components", "ui", "Textarea.tsx"),
  join(process.cwd(), "src", "components", "ui", "Select.tsx"),
  join(process.cwd(), "src", "components", "ui", "Badge.tsx"),
  join(process.cwd(), "src", "components", "ui", "Card.tsx"),
  join(process.cwd(), "src", "components", "ui", "Table.tsx"),
  join(process.cwd(), "src", "components", "ui", "Toolbar.tsx"),
  join(process.cwd(), "src", "components", "ui", "EmptyState.tsx"),
  join(process.cwd(), "src", "components", "ui", "ErrorState.tsx"),
  join(process.cwd(), "src", "routes", "ops.tsx"),
];

describe("migrated surface", () => {
  it("has no raw hex colours in the migrated TSX", async () => {
    for (const file of migratedFiles) {
      const source = await readFile(file, "utf8");
      expect(source, file).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    }
  });

  it("uses only scale font sizes, gaps, paddings and radii in ui.css", async () => {
    const css = await readFile(join(stylesDirectory, "ui.css"), "utf8");
    for (const match of css.matchAll(/font-size:\s*([^;]+);/g)) {
      expect(match[1]?.trim(), "font-size").toMatch(/^var\(--text-[1-8]\)$/);
    }
    for (const match of css.matchAll(/gap:\s*([^;]+);/g)) {
      expect(match[1]?.trim(), "gap").toMatch(/^var\(--space-[1-8]\)$/);
    }
    for (const match of css.matchAll(/padding:\s*([^;]+);/g)) {
      for (const part of (match[1] ?? "").trim().split(/\s+/)) {
        expect(part, "padding").toMatch(/^(0|var\(--space-[1-8]\))$/);
      }
    }
    for (const match of css.matchAll(/border-radius:\s*([^;]+);/g)) {
      expect(match[1]?.trim(), "radius").toMatch(/^(var\(--radius-[1-5]\)|var\(--radius-pill\)|50%)$/);
    }
  });
});
```

- [ ] **Step 2: Write the failing Ops assertions**

Update `plus/apps/web/src/routes/ops.test.tsx` by replacing the first test with:

```tsx
  it("uses the Console header, toolbar and data table primitives", () => {
    render(<OpsPage />);

    expect(screen.getByRole("heading", { name: "活动" })).toHaveClass("ui-page-title");
    expect(screen.getByRole("heading", { name: "活动" })).not.toHaveClass("results-title");
    expect(screen.getByRole("search", { name: "活动筛选" })).toHaveClass("ui-toolbar");
    expect(screen.getByRole("searchbox", { name: "搜索活动" })).toHaveClass("ui-input");
    expect(screen.getByRole("combobox", { name: "按状态筛选" })).toHaveClass("ui-select");
    expect(screen.getByRole("table", { name: "活动列表" })).toHaveClass("ui-table");
    expect(document.querySelector('td[data-label="公开码"]')).not.toBeNull();
  });
```

Replace the second test's search query with the labeled input:

```tsx
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索活动" }), {
      target: { value: "夏季" },
    });
```

This remains the same accessible name, so the existing query still works; the change is only the class assertion.

- [ ] **Step 3: Run the Ops test to verify it fails**

Run:

```powershell
pnpm -C plus --filter @artflow-plus/web exec vitest run src/routes/ops.test.tsx
```

Expected: FAIL because the page still renders the legacy toolbar and table.

- [ ] **Step 4: Replace the Ops page markup**

Replace `plus/apps/web/src/routes/ops.tsx` with:

```tsx
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { fetchOpsActivities } from "../api/ops.js";
import { RequireSession } from "../auth/RequireSession.js";
import { hasOpsAccess, useSession } from "../auth/SessionProvider.js";
import { ConsolePagination } from "../components/console/ConsolePagination.js";
import { ErrorState } from "../components/ui/ErrorState.js";
import { EmptyState } from "../components/ui/EmptyState.js";
import { Input } from "../components/ui/Input.js";
import { Select } from "../components/ui/Select.js";
import { Table } from "../components/ui/Table.js";
import { Toolbar } from "../components/ui/Toolbar.js";

const PAGE_SIZE = 25;

export function OpsPage() {
  return (
    <RequireSession>
      <OpsContent />
    </RequireSession>
  );
}

function OpsContent() {
  const { session } = useSession();
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [searchTerm, statusFilter]);
  const allowed = hasOpsAccess(session);
  const query = useQuery({
    queryKey: ["ops-activities"],
    queryFn: fetchOpsActivities,
    enabled: allowed,
    retry: false,
  });

  if (!allowed) {
    return (
      <EmptyState
        title="没有运营权限"
        description="当前账号不能访问 Ops。"
      />
    );
  }
  if (query.isPending) return <p className="auth-loading">正在加载活动…</p>;
  if (query.error !== null) {
    return (
      <ErrorState
        description="活动列表暂时无法加载。"
        onRetry={() => { void query.refetch(); }}
      />
    );
  }
  const normalizedSearch = searchTerm.trim().toLocaleLowerCase();
  const statuses = [...new Set(query.data.map((activity) => activity.status))].sort();
  const filteredActivities = query.data.filter((activity) => {
    const matchesSearch = normalizedSearch.length === 0 ||
      `${activity.title} ${activity.publicCode}`.toLocaleLowerCase().includes(normalizedSearch);
    return matchesSearch && (statusFilter.length === 0 || activity.status === statusFilter);
  });
  const totalPages = Math.max(1, Math.ceil(filteredActivities.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const paginatedActivities = filteredActivities.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  return (
    <section className="ops-page">
      <header className="ops-header">
        <h1 className="ui-page-title">活动</h1>
        <p className="ui-page-meta">{query.data.length} 个活动 · {filteredActivities.length} 个匹配</p>
      </header>
      {query.data.length === 0 ? (
        <EmptyState title="还没有活动" description="创建第一个活动后从这里开始。" />
      ) : (
        <>
          <Toolbar label="活动筛选">
            <Input
              type="search"
              label="搜索活动"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder="搜索名称或公开码"
            />
            <Select
              label="按状态筛选"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
            >
              <option value="">全部状态</option>
              {statuses.map((status) => <option key={status} value={status}>{status}</option>)}
            </Select>
          </Toolbar>
          {filteredActivities.length === 0 ? (
            <EmptyState title="没有匹配的活动" description="调整搜索词或状态筛选。" />
          ) : (
            <Table caption="活动列表">
              <thead>
                <tr>
                  <th scope="col">活动</th>
                  <th scope="col">公开码</th>
                  <th scope="col">状态</th>
                </tr>
              </thead>
              <tbody>
                {paginatedActivities.map((activity) => (
                  <tr key={activity.id}>
                    <td data-label="活动">
                      <Link
                        to="/ops/$activityId"
                        params={{ activityId: activity.id }}
                        className="table-link"
                      >
                        {activity.title}
                      </Link>
                    </td>
                    <td data-label="公开码">{activity.publicCode}</td>
                    <td data-label="状态">{activity.status}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          <ConsolePagination page={currentPage} totalPages={totalPages} onPageChange={setPage} />
        </>
      )}
    </section>
  );
}
```

- [ ] **Step 5: Replace the Ops list styles**

In `plus/apps/web/src/styles/ops.css`, replace the `.ops-page` and `.ops-header` rules with:

```css
.ops-page { max-width: 1100px; }

.ops-header {
  display: flex;
  align-items: baseline;
  gap: var(--space-3);
  margin-bottom: var(--space-5);
}

.ui-page-title {
  margin: 0;
  font-family: var(--font-ui-display);
  font-size: var(--text-6);
  font-weight: var(--weight-semibold);
  line-height: var(--leading-tight);
  letter-spacing: -0.02em;
}

.ui-page-meta {
  margin: 0;
  color: var(--color-text-muted);
  font-size: var(--text-2);
  line-height: var(--leading-ui);
}
```

Keep the rest of `ops.css` (the detail-page cards) unchanged for the follow-up migration.

- [ ] **Step 6: Run the Ops and token tests**

Run:

```powershell
pnpm -C plus --filter @artflow-plus/web exec vitest run src/routes/ops.test.tsx src/styles/token-contract.test.ts
```

Expected: PASS. If the `ui.css` scale scan flags a value, replace it with the nearest scale token instead of loosening the regex.

- [ ] **Step 7: Commit**

```powershell
git add plus/apps/web/src/routes/ops.tsx plus/apps/web/src/routes/ops.test.tsx plus/apps/web/src/styles/ops.css plus/apps/web/src/styles/token-contract.test.ts
git commit -m "feat(web): migrate the Ops activity list to primitives"
```

---

## Task 12: Mobile card rows and responsive E2E

**Files:**

- Modify: `plus/apps/web/src/styles/ui.css`
- Modify: `plus/apps/web/src/styles/token-contract.test.ts`
- Create: `plus/apps/web/e2e/ops-responsive.spec.ts`

- [ ] **Step 1: Add the failing responsive CSS assertion**

Append to `plus/apps/web/src/styles/token-contract.test.ts`:

```ts
  it("declares the mobile card-table contract", async () => {
    const css = await readFile(join(stylesDirectory, "ui.css"), "utf8");
    expect(css).toContain("@media (max-width: 767px)");
    expect(css).toContain(".ui-table thead");
    expect(css).toContain("content: attr(data-label)");
    expect(css).toContain("display: block");
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```powershell
pnpm -C plus --filter @artflow-plus/web exec vitest run src/styles/token-contract.test.ts
```

Expected: FAIL on the missing media query.

- [ ] **Step 3: Add the mobile card rules**

Append to `plus/apps/web/src/styles/ui.css` inside `@layer components`:

```css
  @media (max-width: 767px) {
    .ui-toolbar { align-items: stretch; }
    .ui-toolbar .ui-field { flex: 1 1 100%; min-width: 0; }
    .ui-table-wrap { overflow: visible; border: 0; background: transparent; }
    .ui-table thead {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
    .ui-table,
    .ui-table tbody,
    .ui-table tr,
    .ui-table td { display: block; width: 100%; }
    .ui-table tr {
      margin-bottom: var(--space-3);
      border: 1px solid var(--color-line);
      border-radius: var(--radius-3);
      background: var(--color-surface);
      padding: var(--space-3);
    }
    .ui-table td {
      display: flex;
      justify-content: space-between;
      gap: var(--space-3);
      padding: var(--space-1) 0;
      border: 0;
      white-space: normal;
    }
    .ui-table td::before {
      content: attr(data-label);
      flex: none;
      color: var(--color-text-muted);
      font-size: var(--text-1);
    }
    .ui-table td:last-child { justify-content: flex-end; }
  }
```

- [ ] **Step 4: Add the responsive E2E test**

Create `plus/apps/web/e2e/ops-responsive.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

test("Ops list keeps a table at 1440 and card rows without horizontal scroll at 390", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("用户名").fill("e2e-ops");
  await page.getByLabel("密码").fill("e2e-ops-password");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(/\/workspace$/);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/ops");
  await expect(page.getByRole("heading", { name: "活动" })).toBeVisible();
  await expect(page.getByRole("table", { name: "活动列表" })).toBeVisible();
  const desktopHeadPosition = await page.locator(".ui-table thead").evaluate((element) => getComputedStyle(element).position);
  expect(desktopHeadPosition).not.toBe("absolute");

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('td[data-label="公开码"]').first()).toBeVisible();
  const mobileHeadPosition = await page.locator(".ui-table thead").evaluate((element) => getComputedStyle(element).position);
  expect(mobileHeadPosition).toBe("absolute");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow).toBe(false);
});
```

- [ ] **Step 5: Run the CSS test and the E2E test**

Run:

```powershell
pnpm -C plus --filter @artflow-plus/web exec vitest run src/styles/token-contract.test.ts
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
pnpm -C plus --filter @artflow-plus/web exec playwright test e2e/ops-responsive.spec.ts
```

Expected: Vitest PASS; Playwright PASS. If the E2E login lands on `/workspace` and the Ops nav is not visible at 390, navigate directly with `page.goto("/ops")` as shown.

- [ ] **Step 6: Commit**

```powershell
git add plus/apps/web/src/styles/ui.css plus/apps/web/src/styles/token-contract.test.ts plus/apps/web/e2e/ops-responsive.spec.ts
git commit -m "feat(web): add mobile card rows for the Ops list"
```

---

## Task 13: Full gates and documentation

**Files:**

- Modify: `docs/artflow-plus/frontend-design-direction.md`
- Modify: `docs/artflow-plus/specs/2026-11-12-design-token-system-design.md` (status only)

- [ ] **Step 1: Update the design-direction pointer**

At the top of `docs/artflow-plus/frontend-design-direction.md`, after the status line, add:

```markdown
> Token、primitive 与响应式的实施规格见
> `specs/2026-11-12-design-token-system-design.md`。
> 本文件保留页面类型、双壳方向与视觉原则；当两份文档冲突时，以 token 规格为准。
```

- [ ] **Step 2: Mark the spec implementation status**

In `docs/artflow-plus/specs/2026-11-12-design-token-system-design.md`, change the status line to:

```markdown
状态：Phase 1 已实现（2026-11-12）；后续页面迁移见实施计划。
```

- [ ] **Step 3: Run the focused gates**

Run:

```powershell
pnpm -C plus --filter @artflow-plus/web run test
pnpm -C plus --filter @artflow-plus/web run check
pnpm -C plus --filter @artflow-plus/web run build
pnpm -C plus run graph:check
pnpm -C plus run test
pwsh -NoProfile -File scripts/check_docs.ps1
```

Expected: all pass. If `pnpm -C plus run test` needs PostgreSQL, export `ARTFLOW_PLUS_DATABASE_URL` and `REQUIRE_DB=1` first.

- [ ] **Step 4: Review the remaining legacy references**

Use the Grep tool with pattern `var\(--(gold|bone|ink|line|glass|display|sans)\)` and path `plus/apps/web/src`.

Expected: matches only in files not yet migrated. Add the count to the follow-up plan; do not delete the aliases in Phase 1.

- [ ] **Step 5: Commit**

```powershell
git add docs/artflow-plus/frontend-design-direction.md docs/artflow-plus/specs/2026-11-12-design-token-system-design.md
git commit -m "docs(web): mark the token foundation phase as implemented"
```

---

## Test architecture

- **Contracts and capabilities touched**: this plan changes only the web style layer and
  `components/ui` primitives. It adds no API route, database migration, domain event, or
  realtime topic, and it registers no new capability. The contracts it must keep are the token
  scale in `tokens.css`, the className contract of every primitive, and the three theme
  palettes; `token-contract.test.ts`, `theme-contrast.test.ts`, and `base.test.ts` assert them.
- **Consumers and read models**: the consumers are the Portal and Console shells, the Ops list
  and detail pages used as the migration pilot, and the dev-only token sheet. They all read the
  same semantic tokens; switching a theme or a viewport tier must not create a second read
  model or a second source of truth.
- **Lifecycle, terminal guards, and mode isolation**: there is no persisted lifecycle and no
  `test`/`rehearsal`/`formal` partition in this plan. The only authority boundary is the token
  sheet visual baseline: a deliberate visual change must regenerate the baseline in the same
  change, so a stale baseline cannot silently pass as the terminal state.
- **Adapters**: no contract adapter is added. The integration seam is the real page rendered in
  Playwright: tests drive the actual router, shell, and CSS, and never mock computed styles.
- **Fault and recovery cases**: static styling has no runtime fault-injection point. The
  reproducible failures worth covering are an undefined token, an undefined className, a theme
  that fails contrast, and a 390/768/1024 layout that scrolls horizontally or shrinks a touch
  target. `token-contract.test.ts`, `theme-contrast.test.ts`, the 1440/1024/390 visual
  baselines, and `ops-responsive.spec.ts` cover those; each failure prints the offending
  selector, token, or viewport so it can be reproduced.
- **Why existing tests are insufficient**: the current surface tests only assert that a few
  classes exist. They do not prove that sizes, gaps, and radii come from one scale, that every
  className is defined, that all three themes pass contrast, or that mobile layouts replace
  tables with complete card rows. A per-page snapshot can stay green while the scale keeps
  growing, so this plan adds the closed-scale and visual gates instead of more page copies.
- **Anti-bloat decision**: extend the existing `token-contract`, `theme-contrast`, and Playwright
  visual suites rather than adding a second styling test framework. Primitives are demonstrated
  once in the token sheet, and page tests assert behavior, not a duplicated visual matrix.
- **Focused gates**: `pnpm -C plus --filter @artflow-plus/web run test`,
  `pnpm -C plus --filter @artflow-plus/web run check`,
  `pnpm -C plus --filter @artflow-plus/web exec playwright test e2e/tokens.spec.ts e2e/ops-responsive.spec.ts`,
  `pnpm -C plus run graph:check`, and `uv run pytest tests/gates -q`.

## Self-review checklist

- Spec coverage: closed scale (Task 1), themes (Task 2), typography/reduced motion (Task 3), theme switching (Task 4), primitives (Tasks 5–9), token sheet (Task 10), Ops proof (Task 11), mobile (Task 12), gates/docs (Task 13).
- No placeholders: every code step contains the actual file body or test body.
- Type consistency: `ButtonVariant`/`ButtonSize` in Task 5 match later usage; `ThemeName` in Task 4 matches `themes.css`; `Table`/`Toolbar` props match the Ops page; `Input`/`Select` labels match the `ops.test.tsx` queries.
- Deferred explicitly: Studio/Live/Portal migration, deletion of `legacy-aliases.css`, Portal display-font code splitting, and full-page pixel baselines.
