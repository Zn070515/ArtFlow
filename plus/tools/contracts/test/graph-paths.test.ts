import { describe, expect, it } from "vitest";

import { plusRelative } from "../src/graph/paths.js";

describe("impact diff paths", () => {
  it("strips the plus workspace prefix used by git diffs", () => {
    expect(plusRelative("plus/packages/runtime/src/command.ts")).toBe("packages/runtime/src/command.ts");
    expect(plusRelative("docs/development-baseline.md")).toBe("docs/development-baseline.md");
  });
});
