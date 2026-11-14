import { describe, expect, it } from "vitest";

import {
  patchCapabilityPayload,
  readCapabilityPayload,
} from "./definitionPackage.js";

describe("definitionPackage", () => {
  const pkg = {
    schemaVersion: 1,
    manifest: { key: "pkg-1", title: "2026 院十佳" },
    capabilities: {
      registration: {
        schemaVersion: 1,
        payload: { lifecycle: "open", lifecycleVersion: 1 },
      },
      competition: {
        schemaVersion: 1,
        payload: { rounds: [{ key: "final" }] },
      },
    },
    bindings: [{ from: "roster", to: "final", kind: "roster" }],
    futureField: { keep: true },
  };

  it("reads the payload for an enabled capability", () => {
    expect(readCapabilityPayload(pkg, "registration")).toEqual({
      lifecycle: "open",
      lifecycleVersion: 1,
    });
    expect(readCapabilityPayload(pkg, "missing")).toBeUndefined();
  });

  it("patches one capability without losing unknown fields", () => {
    const next = patchCapabilityPayload(pkg, "registration", {
      lifecycle: "final",
      lifecycleVersion: 1,
    });

    expect(readCapabilityPayload(next, "registration")).toEqual({
      lifecycle: "final",
      lifecycleVersion: 1,
    });
    expect(readCapabilityPayload(next, "competition")).toEqual({ rounds: [{ key: "final" }] });
    expect((next as typeof pkg).manifest).toEqual(pkg.manifest);
    expect((next as typeof pkg).bindings).toEqual(pkg.bindings);
    expect((next as typeof pkg).futureField).toEqual({ keep: true });
    // The original object is not mutated.
    expect(readCapabilityPayload(pkg, "registration")).toEqual({
      lifecycle: "open",
      lifecycleVersion: 1,
    });
  });

  it("creates a capability entry when the draft does not have it yet", () => {
    const next = patchCapabilityPayload(pkg, "publishing", { stages: [{ key: "result" }] });
    expect(readCapabilityPayload(next, "publishing")).toEqual({ stages: [{ key: "result" }] });
    expect((next as typeof pkg).manifest).toEqual(pkg.manifest);
  });

  it("returns a safe minimal package for malformed input", () => {
    const next = patchCapabilityPayload(null, "voting", { purpose: "popularity" });
    expect(readCapabilityPayload(next, "voting")).toEqual({ purpose: "popularity" });
  });
});
