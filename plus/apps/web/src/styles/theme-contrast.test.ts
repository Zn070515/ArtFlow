import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readAllStyles } from "./read-styles.js";

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

  it("keeps the lowest-emphasis Portal text above WCAG AA", async () => {
    const palette = declarations(await readFile(join(stylesDirectory, "palette.css"), "utf8"));
    const themes = await readFile(join(stylesDirectory, "themes.css"), "utf8");
    const local = declarations(themeBlock(themes, "afterglow"));
    const subtle = hex(resolve("color-text-subtle", local, palette), "color-text-subtle");
    const page = hex(resolve("color-page", local, palette), "color-page");
    const surface = hex(resolve("color-surface", local, palette), "color-surface");

    expect(contrast(subtle, page), "afterglow: subtle on page").toBeGreaterThanOrEqual(4.5);
    expect(contrast(subtle, surface), "afterglow: subtle on surface").toBeGreaterThanOrEqual(4.5);

    const global = await readAllStyles(stylesDirectory);
    expect(global).toMatch(/\.footnote\s*\{[^}]*var\(--bone-subtle\)/s);
    expect(global).toMatch(/\.site-footer\s*\{[^}]*var\(--bone-subtle\)/s);
  });
});
