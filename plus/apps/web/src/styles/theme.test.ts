import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const stylesDirectory = join(process.cwd(), "src", "styles");

describe("ArtFlow visual theme styles", () => {
  it("declares both theme presets and Console layout roles", async () => {
    const tokens = await readFile(`${stylesDirectory}/tokens.css`, "utf8");
    const global = await readFile(`${stylesDirectory}/global.css`, "utf8");

    expect(tokens).toContain('[data-theme="afterglow"]');
    expect(tokens).toContain('[data-theme="signal"]');
    expect(tokens).toContain("--color-surface-raised");
    expect(global).toContain(".console-shell");
    expect(global).toContain(".console-table-wrap");
  });

  it("keeps Console surfaces opaque and avoids Portal-only blur", async () => {
    const global = await readFile(`${stylesDirectory}/global.css`, "utf8");
    const consoleCss = global.slice(global.indexOf(".console-shell"));

    expect(consoleCss).not.toContain("backdrop-filter: blur");
    expect(consoleCss).not.toContain("color: var(--ink)");
    expect(consoleCss).not.toContain("rgba(232, 180, 90");
    expect(consoleCss).toContain("min-height: 100vh");
  });

  it("keeps Console styling on semantic Signal tokens", async () => {
    const global = await readFile(`${stylesDirectory}/global.css`, "utf8");

    expect(global).not.toContain("var(--muted, #666)");
    expect(global).not.toContain("var(--line, #ddd)");
    expect(global).toContain("font-variant-numeric: tabular-nums");
    expect(global).toContain("var(--color-focus)");
  });

  it("removes keyboard reachability from a closed mobile sidebar", async () => {
    const global = await readFile(`${stylesDirectory}/global.css`, "utf8");

    expect(global).toContain("visibility: hidden");
    expect(global).toContain("pointer-events: none");
    expect(global).toContain(".console-sidebar.is-open");
    expect(global).toContain("visibility: visible");
  });
});
