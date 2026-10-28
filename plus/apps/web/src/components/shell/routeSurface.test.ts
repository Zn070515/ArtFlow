import { describe, expect, it } from "vitest";

import { getShellSurface } from "./routeSurface.js";

describe("getShellSurface", () => {
  it.each(["/ops", "/ops/activity-1", "/studio", "/live/act-1", "/judge/public-code", "/join", "/login"])(
    "assigns %s to the Console shell",
    (pathname) => {
      expect(getShellSurface(pathname)).toBe("console");
    },
  );

  it.each(["/", "/results/public-code", "/vote/session-1", "/claim", "/unknown"])(
    "assigns %s to the Portal shell",
    (pathname) => {
      expect(getShellSurface(pathname)).toBe("portal");
    },
  );

  it("does not treat a similarly named path as a Console route", () => {
    expect(getShellSurface("/ops-extra")).toBe("portal");
  });
});
