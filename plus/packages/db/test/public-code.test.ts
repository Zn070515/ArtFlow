import { describe, expect, it } from "vitest";

import {
  ACTIVITY_PUBLIC_CODE_ALPHABET,
  ACTIVITY_PUBLIC_CODE_PATTERN,
  canonicalActivityPublicCode,
  createActivityPublicCode,
} from "../src/public-code.js";

describe("activity public code", () => {
  it("builds a short code that can be read aloud and is not an activity id", () => {
    let cursor = 0;
    const code = createActivityPublicCode(() => {
      const next = cursor % ACTIVITY_PUBLIC_CODE_ALPHABET.length;
      cursor += 1;
      return next;
    });
    expect(code).toBe("2345-6789");
    expect(code).toMatch(ACTIVITY_PUBLIC_CODE_PATTERN);
    expect(code).not.toMatch(/^act_/);
    expect(ACTIVITY_PUBLIC_CODE_ALPHABET).not.toMatch(/[01ILOU]/);

    const randomCode = createActivityPublicCode();
    expect(randomCode).toMatch(ACTIVITY_PUBLIC_CODE_PATTERN);
    expect(randomCode).not.toBe("act_e0cd1683896d516f0a515f41");
  });

  it("accepts spoken spacing and case, and leaves internal ids alone", () => {
    expect(canonicalActivityPublicCode(" k7m4-p2qx ")).toBe("K7M4-P2QX");
    expect(canonicalActivityPublicCode("k7m4 p2qx")).toBe("K7M4-P2QX");
    expect(canonicalActivityPublicCode("k7m4p2qx")).toBe("K7M4-P2QX");
    expect(canonicalActivityPublicCode("act_e0cd1683896d516f0a515f41")).toBe(
      "act_e0cd1683896d516f0a515f41",
    );
    expect(canonicalActivityPublicCode("E2E-REG")).toBe("E2E-REG");
    expect(canonicalActivityPublicCode("ABC123")).toBe("ABC123");
  });
});
