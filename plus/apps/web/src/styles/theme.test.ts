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

  it("declares the color scheme early and brands native controls", async () => {
    const themes = await readFile(`${stylesDirectory}/themes.css`, "utf8");
    const html = await readFile(join(process.cwd(), "index.html"), "utf8");

    expect(html).toContain('<meta name="color-scheme" content="light dark" />');
    expect(themes).toContain("accent-color: var(--color-accent)");
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

  it("defines the default Portal theme at the root and scopes legacy aliases to themes", async () => {
    const themes = await readFile(`${stylesDirectory}/themes.css`, "utf8");
    const aliases = await readFile(`${stylesDirectory}/legacy-aliases.css`, "utf8");

    expect(themes).toMatch(/:root,\s*\[data-theme="afterglow"\]/);
    expect(aliases).not.toContain(":root {");
    expect(aliases).toContain(':is([data-theme="paper"], [data-theme="graphite"], [data-theme="afterglow"])');
  });

  it("removes keyboard reachability from a closed mobile sidebar", async () => {
    const global = await readAllStyles(stylesDirectory);

    expect(global).toContain("visibility: hidden");
    expect(global).toContain("pointer-events: none");
    expect(global).toContain(".console-sidebar.is-open");
    expect(global).toContain("visibility: visible");
  });
});
