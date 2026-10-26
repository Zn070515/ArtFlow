import { afterEach, describe, expect, it, vi } from "vitest";

import { resetRehearsal } from "./live.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("live client", () => {
  it("posts the rehearsal reset with the judging scope and mode", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ round: { state: "prepared" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await resetRehearsal("act-1", "round-1", "rehearsal");

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/activities/act-1/competition/rounds/round-1/reset-rehearsal");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers as HeadersInit).get("idempotency-key")).toEqual(expect.any(String));
    expect(JSON.parse(String(init.body))).toEqual({ scope: "judging", mode: "rehearsal" });
  });
});
