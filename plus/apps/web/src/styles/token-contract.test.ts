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
