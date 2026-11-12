import { describe, expect, it, vi } from "vitest";

import type { SessionResponse } from "../api/auth.js";

vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn(),
  useQueryClient: vi.fn(),
}));

vi.mock("../api/auth.js", () => ({
  fetchMe: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  registerParticipant: vi.fn(),
}));

import { defaultLanding, hasWorkspaceAccess } from "./SessionProvider.js";

function session(permissions: readonly string[], roles: readonly string[] = []): SessionResponse {
  return {
    actor: { actorId: "actor-1", actorType: "staff", permissions, roles },
    csrfToken: "csrf",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
}

describe("organizer workspace access", () => {
  it.each([
    ["ops", session(["registration.review"], ["staff"])],
    ["studio", session(["studio.manage"])],
    ["live", session(["competition.manage"])],
  ])("sends %s actors to the workspace", (_label, value) => {
    expect(hasWorkspaceAccess(value)).toBe(true);
    expect(defaultLanding(value)).toBe("/workspace");
  });

  it("does not infer organizer access from a descriptive role alone", () => {
    const value = session([], ["staff"]);

    expect(hasWorkspaceAccess(value)).toBe(false);
    expect(defaultLanding(value)).toBe("/join");
  });

  it("keeps participant-only accounts on the join flow", () => {
    const value = session([], ["participant"]);

    expect(hasWorkspaceAccess(value)).toBe(false);
    expect(defaultLanding(value)).toBe("/join");
  });

  it("does not treat an anonymous session as an organizer", () => {
    expect(hasWorkspaceAccess(null)).toBe(false);
  });
});
