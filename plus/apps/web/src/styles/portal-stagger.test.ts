import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const css = readFileSync(join(process.cwd(), "src", "styles", "portal.css"), "utf8");

describe("portal rank stagger", () => {
  it("uses sibling-index with a custom-property fallback", () => {
    expect(css).toContain(
      "animation-delay: calc(var(--sibling-index, 1) * var(--stagger-step) + var(--stagger-offset));",
    );
    expect(css).toContain(
      "animation-delay: calc(sibling-index() * var(--stagger-step) + var(--stagger-offset));",
    );
  });

  it("does not reintroduce per-child delay rules", () => {
    expect(css).not.toMatch(/\.rank-row:nth-child\([2-5]\)\s*\{/);
  });
});
