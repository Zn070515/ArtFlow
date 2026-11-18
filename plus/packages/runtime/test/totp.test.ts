import { describe, expect, it } from "vitest";

import { base32Decode, generateTotpSecret, otpauthUrl, totpCode, verifyTotp } from "../src/totp.js";

describe("TOTP", () => {
  it("matches the RFC 6238 SHA-1 vector at 59 seconds", () => {
    // RFC 6238 secret "12345678901234567890" in base32.
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    expect(totpCode(secret, 59_000)).toBe("287082");
  });

  it("accepts one step of clock skew and rejects unrelated codes", () => {
    const secret = generateTotpSecret();
    const now = 1_800_000_000_000;
    const code = totpCode(secret, now);
    expect(verifyTotp(secret, code, now)).toBe(true);
    expect(verifyTotp(secret, totpCode(secret, now - 30_000), now)).toBe(true);
    expect(verifyTotp(secret, "000000", now)).toBe(false);
    expect(verifyTotp(secret, "abc", now)).toBe(false);
  });

  it("produces a usable otpauth URL and decodes its secret", () => {
    const secret = generateTotpSecret();
    const url = otpauthUrl("ArtFlow", "alice@example.com", secret);
    expect(url).toContain("otpauth://totp/ArtFlow:alice%40example.com");
    expect(url).toContain(`secret=${secret}`);
    expect(base32Decode(secret).length).toBeGreaterThanOrEqual(16);
  });
});
