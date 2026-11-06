import { afterEach, describe, expect, it, vi } from "vitest";

import { apiFetch } from "./client.js";
import { consumeParticipantClaim, issueParticipantClaim } from "./participantClaim.js";

vi.mock("./client.js", () => ({
  apiFetch: vi.fn(),
}));

const apiFetchMock = vi.mocked(apiFetch);

afterEach(() => {
  vi.clearAllMocks();
});

describe("participant claim API", () => {
  it("issues a claim through the registration route", async () => {
    apiFetchMock.mockResolvedValue({
      token: "AF1.CLAIM.claim-1.secret",
      activityId: "activity-1",
      publicCode: "E2E-REG",
      title: "E2E activity",
      expiresAt: "2026-11-08T00:00:00.000Z",
    });

    await expect(issueParticipantClaim("activity-1", "registration-1", "issue-1")).resolves.toMatchObject({
      token: "AF1.CLAIM.claim-1.secret",
    });
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/activities/activity-1/registrations/registration-1/account-claim",
      expect.objectContaining({
        method: "POST",
        headers: { "idempotency-key": "issue-1" },
        body: "{}",
      }),
    );
  });

  it("sends the claim token only in the public JSON body", async () => {
    apiFetchMock.mockResolvedValue({
      actor: { actorId: "participant:1", actorType: "user", roles: ["participant"], permissions: [] },
      publicCode: "E2E-REG",
      csrfToken: "csrf-1",
      expiresAt: "2026-11-08T00:00:00.000Z",
    });
    const token = "AF1.CLAIM.claim-1.secret";

    await expect(
      consumeParticipantClaim(token, "consume-1", {
        username: "claim-user",
        password: "claim-password-123",
      }),
    ).resolves.toMatchObject({ publicCode: "E2E-REG" });

    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/public/participant-claims/consume",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        headers: { "idempotency-key": "consume-1" },
        body: JSON.stringify({ token, username: "claim-user", password: "claim-password-123" }),
      }),
    );
    expect(apiFetchMock.mock.calls[0]?.[0]).not.toContain(token);
  });
});
