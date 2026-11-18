import { afterEach, describe, expect, it, vi } from "vitest";

import { beginOidcLogin, completeOidcLogin, oidcConfigFromEnv } from "../src/oidc-service.js";

const config = {
  issuer: "https://idp.example",
  clientId: "artflow",
  clientSecret: "secret",
  redirectUri: "https://artflow.example/api/auth/oidc/callback",
  scopes: "openid email",
  clientAuth: "post" as const,
  autoProvision: false,
  label: "统一身份登录",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OIDC", () => {
  it("stays disabled unless issuer and client settings are present", () => {
    expect(oidcConfigFromEnv({})).toBeNull();
    expect(oidcConfigFromEnv({
      ARTFLOW_PLUS_OIDC_ISSUER: "https://idp.example",
      ARTFLOW_PLUS_OIDC_CLIENT_ID: "artflow",
      ARTFLOW_PLUS_OIDC_CLIENT_SECRET: "secret",
      ARTFLOW_PLUS_OIDC_REDIRECT_URI: "https://artflow.example/callback",
    })).toMatchObject({ issuer: "https://idp.example", clientId: "artflow", autoProvision: false });
  });

  it("builds an authorization URL with state, nonce and PKCE", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        authorization_endpoint: "https://idp.example/authorize",
        token_endpoint: "https://idp.example/token",
        jwks_uri: "https://idp.example/jwks",
      }),
    })));
    const start = await beginOidcLogin(config, new Date("2026-11-18T12:00:00Z"));
    const url = new URL(start.authorizationUrl);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("artflow");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toEqual(expect.any(String));
    expect(url.searchParams.get("nonce")).toEqual(expect.any(String));
    expect(start.cookie).toContain(".");
  });

  it("rejects a callback without the signed state cookie", async () => {
    await expect(completeOidcLogin(config, {
      code: "code",
      state: "state",
      cookie: undefined,
    })).rejects.toMatchObject({ code: "OIDC_STATE_INVALID" });
  });
});
