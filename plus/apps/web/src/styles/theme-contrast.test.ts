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

describe("Signal theme contrast", () => {
  it("meets readable text and control contrast thresholds", async () => {
    const tokens = await readFile(`${stylesDirectory}/tokens.css`, "utf8");
    const signal = tokens.slice(tokens.indexOf('[data-theme="signal"]'));
    const page = tokenValue(signal, "color-page");
    const surface = tokenValue(signal, "color-surface");
    const text = tokenValue(signal, "color-text");
    const textMuted = tokenValue(signal, "color-text-muted");
    const accent = tokenValue(signal, "color-accent");
    const accentContrast = tokenValue(signal, "color-accent-contrast");
    const focus = tokenValue(signal, "color-focus");

    expect(contrast(text, page)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(textMuted, surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(accent, surface)).toBeGreaterThanOrEqual(3);
    expect(contrast(accentContrast, accent)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(focus, surface)).toBeGreaterThanOrEqual(3);
  });
});
