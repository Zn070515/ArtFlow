import { describe, expect, it } from "vitest";

import { getShellSurface } from "./routeSurface.js";

describe("getShellSurface", () => {
  it.each(["/ops", "/ops/activity-1", "/studio", "/live/act-1", "/judge/public-code", "/join", "/login", "/workspace", "/workspace/activity-1"])(
    "assigns %s to the Console shell",
    (pathname) => {
      expect(getShellSurface(pathname)).toBe("console");
    },
  );

  it.each(["/", "/results/public-code", "/vote/session-1", "/unknown"])(
    "assigns %s to the Portal shell",
    (pathname) => {
      expect(getShellSurface(pathname)).toBe("portal");
    },
  );

  it("does not treat similarly named paths as a Console route", () => {
    expect(getShellSurface("/ops-extra")).toBe("portal");
    expect(getShellSurface("/workspace-extra")).toBe("portal");
  });
});
