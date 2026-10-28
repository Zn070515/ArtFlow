import { describe, expect, it } from "vitest";

import { assertReleaseProvenance } from "../src/release-provenance.js";

describe("release provenance", () => {
  it("accepts matching baked and configured release SHAs", () => {
    expect(() =>
      assertReleaseProvenance({
        releaseFile: "abc123",
        env: { NODE_ENV: "production", ARTFLOW_RELEASE_SHA: "abc123" },
      }),
    ).not.toThrow();
  });

  it("rejects a missing configured SHA in production", () => {
    expect(() =>
      assertReleaseProvenance({
        releaseFile: "abc123",
        env: { NODE_ENV: "production" },
      }),
    ).toThrow(/ARTFLOW_RELEASE_SHA/);
  });

  it("rejects a mismatch in production", () => {
    expect(() =>
      assertReleaseProvenance({
        releaseFile: "abc123",
        env: { NODE_ENV: "production", ARTFLOW_RELEASE_SHA: "def456" },
      }),
    ).toThrow(/does not match/);
  });

  it("allows a missing marker in development", () => {
    expect(() =>
      assertReleaseProvenance({
        releaseFile: "",
        env: { NODE_ENV: "development" },
      }),
    ).not.toThrow();
  });
});
