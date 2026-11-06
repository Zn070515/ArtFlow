import { afterEach, describe, expect, it, vi } from "vitest";

import { redeemTicket, submitVote } from "./vote.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ticket voting client", () => {
  it("redeems a credential through the cookie-setting endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ ticketId: "ticket-1", accessToken: null }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await redeemTicket("AF1.T.PUBLIC.VERSION.SIGNATURE");

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/tickets/redeem");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers as HeadersInit).get("idempotency-key")).toEqual(expect.any(String));
    expect(JSON.parse(String(init.body))).toEqual({ credential: "AF1.T.PUBLIC.VERSION.SIGNATURE" });
  });

  it("reuses the redemption idempotency key when the same credential is retried", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ ticketId: "ticket-1", accessToken: null }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const credential = "AF1.T.PUBLIC.VERSION.SIGNATURE";

    await redeemTicket(credential);
    await redeemTicket(credential);

    const firstInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const secondInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const firstKey = new Headers(firstInit.headers as HeadersInit).get("idempotency-key");
    const secondKey = new Headers(secondInit.headers as HeadersInit).get("idempotency-key");
    expect(firstKey).toBe(secondKey);
    expect(firstKey).not.toContain(credential);
  });

  it("submits ticket identity without putting the raw credential in the ballot body", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ ballot: { id: "ballot-1" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await submitVote("activity-1", "session-1", ["option-1"], "ticket");

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/activities/activity-1/voting/sessions/session-1/ballots");
    expect(JSON.parse(String(init.body))).toEqual({
      scope: "voting",
      optionIds: ["option-1"],
      identity: { type: "ticket" },
    });
    expect(String(init.body)).not.toContain("AF1.T");
  });
});
