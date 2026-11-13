import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const css = readFileSync(join(process.cwd(), "src", "styles", "base.css"), "utf8");

describe("typography wrapping", () => {
  it("balances headings and prettifies body copy", () => {
    expect(css).toContain("text-wrap: balance");
    expect(css).toContain("text-wrap: pretty");
  });
});
