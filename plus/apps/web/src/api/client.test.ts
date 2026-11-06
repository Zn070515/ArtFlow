import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, apiFetch } from "./client.js";

afterEach(() => {
  vi.unstubAllGlobals();
  document.cookie = "artflow_csrf=; Max-Age=0; Path=/";
});

describe("apiFetch", () => {
  it("returns JSON for successful responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    }));
    await expect(apiFetch("/api/auth/me")).resolves.toEqual({ ok: true });
  });

  it("throws ApiError with the API code", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ code: "CSRF_INVALID", message: "A valid CSRF token is required." }),
    }));
    await expect(apiFetch("/api/activities")).rejects.toMatchObject({
      status: 403,
      code: "CSRF_INVALID",
    });
    await expect(apiFetch("/api/activities")).rejects.toBeInstanceOf(ApiError);
  });

  it("adds the CSRF header for mutations", async () => {
    document.cookie = "artflow_csrf=csrf-123; Path=/";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });
    vi.stubGlobal("fetch", fetchMock);
    await apiFetch("/api/activities/x/close", { method: "POST", body: "{}" });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Headers;
    expect(headers.get("x-csrf-token")).toBe("csrf-123");
    expect(init.credentials).toBe("same-origin");
  });
});
