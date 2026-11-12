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
