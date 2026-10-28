import { describe, expect, it } from "vitest";

import { assertReleaseProvenance } from "../src/release-provenance.js";

const RELEASE_SHA = "a".repeat(40);

describe("release provenance", () => {
  it("accepts matching baked and configured release SHAs", () => {
    expect(() =>
      assertReleaseProvenance({
        releaseFile: RELEASE_SHA,
        env: { NODE_ENV: "production", ARTFLOW_RELEASE_SHA: RELEASE_SHA },
      }),
    ).not.toThrow();
  });

  it("rejects a missing configured SHA in production", () => {
    expect(() =>
      assertReleaseProvenance({
        releaseFile: RELEASE_SHA,
        env: { NODE_ENV: "production" },
      }),
    ).toThrow(/ARTFLOW_RELEASE_SHA/);
  });

  it("rejects a mismatch in production", () => {
    expect(() =>
      assertReleaseProvenance({
        releaseFile: RELEASE_SHA,
        env: { NODE_ENV: "production", ARTFLOW_RELEASE_SHA: "b".repeat(40) },
      }),
    ).toThrow(/does not match/);
  });

  it("rejects a short or placeholder release value in production", () => {
    for (const value of ["abc123", "replace-me-with-the-deployed-commit-sha"]) {
      expect(() =>
        assertReleaseProvenance({
          releaseFile: value,
          env: { NODE_ENV: "production", ARTFLOW_RELEASE_SHA: value },
        }),
      ).toThrow(/40-character Git commit SHA/);
    }
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
