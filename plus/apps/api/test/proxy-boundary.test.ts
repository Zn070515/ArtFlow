import type { Database } from "@artflow-plus/db";
import type { RateLimitInput, RateLimiter } from "@artflow-plus/runtime";
import type { Kysely } from "kysely";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp, parseTrustedProxy, publicErrorMessage, selectRateLimiter } from "../src/app.js";

const originalTrustProxy = process.env.ARTFLOW_PLUS_TRUST_PROXY;

afterEach(() => {
  if (originalTrustProxy === undefined) delete process.env.ARTFLOW_PLUS_TRUST_PROXY;
  else process.env.ARTFLOW_PLUS_TRUST_PROXY = originalTrustProxy;
});

describe("Plus proxy boundary", () => {
  it("does not silently use a process-local limiter in production", () => {
    expect(() => selectRateLimiter({}, { NODE_ENV: "production" })).toThrow(
      "A shared RateLimiter must be supplied in production.",
    );
  });

  it("accepts an explicitly supplied limiter in production", () => {
    const rateLimiter: RateLimiter = { allow: () => true };
    expect(selectRateLimiter({ rateLimiter }, { NODE_ENV: "production" })).toBe(rateLimiter);
  });

  it("uses status-class messages for security-sensitive HTTP errors", () => {
    expect(publicErrorMessage(401, "session detail")).toBe("Authentication required.");
    expect(publicErrorMessage(403, "permission detail")).toBe("Access denied.");
    expect(publicErrorMessage(404, "database detail")).toBe("The requested resource was not found.");
    expect(publicErrorMessage(429, "limiter detail")).toBe("Too many requests.");
    expect(publicErrorMessage(413, "body detail")).toBe("Request body too large.");
    expect(publicErrorMessage(409, "state detail")).toBe("state detail");
  });

  it("defaults to trusting no forwarded proxy", () => {
    delete process.env.ARTFLOW_PLUS_TRUST_PROXY;
    expect(parseTrustedProxy()).toEqual([]);
    expect(parseTrustedProxy(" 10.0.0.0/8, 172.16.0.0/12 ")).toEqual([
      "10.0.0.0/8",
      "172.16.0.0/12",
    ]);
  });

  it("uses the socket address unless the immediate proxy is explicitly trusted", async () => {
    const keys: string[] = [];
    const rateLimiter: RateLimiter = {
      allow: async (input: RateLimitInput) => {
        keys.push(input.key);
        return true;
      },
    };
    const untrusted = await buildApp({
      db: {} as Kysely<Database>,
      rateLimiter,
      trustProxy: [],
    });
    await untrusted.ready();
    await untrusted.inject({
      method: "POST",
      url: "/api/auth/login",
      remoteAddress: "127.0.0.1",
      headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.1" },
      payload: { username: "one", password: "wrong" },
    });
    await untrusted.inject({
      method: "POST",
      url: "/api/auth/login",
      remoteAddress: "127.0.0.1",
      headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.2" },
      payload: { username: "two", password: "wrong" },
    });
    await untrusted.close();
    expect(keys.filter((key) => key.startsWith("auth-login:"))).toEqual([
      "auth-login:127.0.0.1",
      "auth-login:127.0.0.1",
    ]);

    keys.length = 0;
    const trusted = await buildApp({
      db: {} as Kysely<Database>,
      rateLimiter,
      trustProxy: ["127.0.0.1"],
    });
    await trusted.ready();
    await trusted.inject({
      method: "POST",
      url: "/api/auth/login",
      remoteAddress: "127.0.0.1",
      headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.1" },
      payload: { username: "one", password: "wrong" },
    });
    await trusted.inject({
      method: "POST",
      url: "/api/auth/login",
      remoteAddress: "127.0.0.1",
      headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.2" },
      payload: { username: "two", password: "wrong" },
    });
    await trusted.close();
    expect(keys.filter((key) => key.startsWith("auth-login:"))).toEqual([
      "auth-login:198.51.100.1",
      "auth-login:198.51.100.2",
    ]);
  });
});
