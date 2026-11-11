import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const stylesDirectory = join(process.cwd(), "src", "styles");

function tokenValue(css: string, name: string): string {
  const match = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
  expect(match, `missing hex token --${name}`).not.toBeNull();
  return match?.[1] ?? "#000000";
}

function channel(value: number): number {
  const normalized = value / 255;
  return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const red = Number.parseInt(hex.slice(1, 3), 16);
  const green = Number.parseInt(hex.slice(3, 5), 16);
  const blue = Number.parseInt(hex.slice(5, 7), 16);
  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
}

function contrast(first: string, second: string): number {
  const firstLuminance = luminance(first);
  const secondLuminance = luminance(second);
  const light = Math.max(firstLuminance, secondLuminance);
  const dark = Math.min(firstLuminance, secondLuminance);
  return (light + 0.05) / (dark + 0.05);
}

function expectReadableTheme(tokens: string, theme: "signal" | "violet"): void {
  const block = tokens.slice(tokens.indexOf(`[data-theme="${theme}"]`));
  const page = tokenValue(block, "color-page");
  const surface = tokenValue(block, "color-surface");
  const text = tokenValue(block, "color-text");
  const textMuted = tokenValue(block, "color-text-muted");
  const accent = tokenValue(block, "color-accent");
  const accentContrast = tokenValue(block, "color-accent-contrast");
  const focus = tokenValue(block, "color-focus");

  expect(contrast(text, page), `${theme}: text on page`).toBeGreaterThanOrEqual(4.5);
  expect(contrast(textMuted, surface), `${theme}: muted text on surface`).toBeGreaterThanOrEqual(4.5);
  expect(contrast(accent, surface), `${theme}: accent on surface`).toBeGreaterThanOrEqual(3);
  expect(contrast(accentContrast, accent), `${theme}: text on accent`).toBeGreaterThanOrEqual(4.5);
  expect(contrast(focus, surface), `${theme}: focus on surface`).toBeGreaterThanOrEqual(3);
}

function rgbaValue(css: string, name: string): { red: number; green: number; blue: number; alpha: number } {
  const match = css.match(
    new RegExp(`--${name}:\\s*rgba\\((\\d+),\\s*(\\d+),\\s*(\\d+),\\s*([\\d.]+)\\)`),
  );
  expect(match, `missing rgba token --${name}`).not.toBeNull();
  return {
    red: Number(match?.[1]),
    green: Number(match?.[2]),
    blue: Number(match?.[3]),
    alpha: Number(match?.[4]),
  };
}

function compositeOver(
  foreground: { red: number; green: number; blue: number; alpha: number },
  backgroundHex: string,
): string {
  const background = {
    red: Number.parseInt(backgroundHex.slice(1, 3), 16),
    green: Number.parseInt(backgroundHex.slice(3, 5), 16),
    blue: Number.parseInt(backgroundHex.slice(5, 7), 16),
  };
  const blend = (front: number, back: number): number =>
    Math.round(front * foreground.alpha + back * (1 - foreground.alpha));
  return `#${[blend(foreground.red, background.red), blend(foreground.green, background.green), blend(foreground.blue, background.blue)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}

describe("theme contrast", () => {
  it("meets readable text and control contrast thresholds", async () => {
    const tokens = await readFile(`${stylesDirectory}/tokens.css`, "utf8");
    expectReadableTheme(tokens, "signal");
    expectReadableTheme(tokens, "violet");
  });

  it("keeps the lowest-emphasis portal text above WCAG AA", async () => {
    const tokens = await readFile(`${stylesDirectory}/tokens.css`, "utf8");
    const global = await readFile(`${stylesDirectory}/global.css`, "utf8");
    const root = tokens.slice(0, tokens.indexOf('[data-theme="afterglow"]'));
    const violet = tokens.slice(tokens.indexOf('[data-theme="violet"]'));

    expect(contrast(compositeOver(rgbaValue(root, "bone-subtle"), "#07070a"), "#07070a")).toBeGreaterThanOrEqual(4.5);
    expect(contrast(compositeOver(rgbaValue(violet, "bone-subtle"), "#0b0916"), "#0b0916")).toBeGreaterThanOrEqual(4.5);
    expect(global).toMatch(/\.footnote\s*\{[^}]*color:\s*var\(--bone-subtle\)/s);
    expect(global).toMatch(/\.site-footer\s*\{[^}]*color:\s*var\(--bone-subtle\)/s);
  });
});
