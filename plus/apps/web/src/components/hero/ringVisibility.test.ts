import { describe, expect, it } from "vitest";

import { shouldRenderChromeRing } from "./ringVisibility.js";

describe("shouldRenderChromeRing", () => {
  it("drops the decoration where it would cover the hero copy", () => {
    expect(shouldRenderChromeRing(320)).toBe(false);
    expect(shouldRenderChromeRing(375)).toBe(false);
    expect(shouldRenderChromeRing(600)).toBe(false);
  });

  it("keeps the ring on wider viewports", () => {
    expect(shouldRenderChromeRing(640)).toBe(true);
    expect(shouldRenderChromeRing(1280)).toBe(true);
  });
});
