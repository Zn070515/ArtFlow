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

  it("declares the mobile card-table contract", async () => {
    const css = await readFile(join(stylesDirectory, "ui.css"), "utf8");
    expect(css).toContain("@media (max-width: 767px)");
    expect(css).toContain(".ui-table thead");
    expect(css).toContain("content: attr(data-label)");
    expect(css).toContain("display: block");
  });
});
