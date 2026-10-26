import { describe, expect, it } from "vitest";

import { isProductionEnvironment, sessionCookie } from "../src/cookies.js";

describe("session cookies", () => {
  it("treats either NODE_ENV or APP_ENV production as production", () => {
    expect(isProductionEnvironment({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toBe(true);
    expect(isProductionEnvironment({ APP_ENV: "production" } as NodeJS.ProcessEnv)).toBe(true);
    expect(isProductionEnvironment({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it("marks the cookie Secure only when production", () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    expect(sessionCookie("artflow_judge_session", "token", expiresAt, true)).toContain("; Secure");
    expect(sessionCookie("artflow_judge_session", "token", expiresAt, false)).not.toContain("; Secure");
  });
});
