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

import {
  canManageCompetition,
  canManageCompetitionSetup,
  canManageLiveSession,
  canPrepareCompetitionRound,
  canResolveCompetition,
  defaultLanding,
  hasLiveAccess,
  hasWorkspaceAccess,
} from "./SessionProvider.js";

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

describe("canManageCompetition", () => {
  it("accepts competition manage, score write, and wildcard permissions", () => {
    expect(canManageCompetition(session(["competition.manage"]))).toBe(true);
    expect(canManageCompetition(session(["competition.score.write"]))).toBe(true);
    expect(canManageCompetition(session(["*"]))).toBe(true);
  });

  it("rejects judge-only and null sessions", () => {
    expect(canManageCompetition(session(["judge.manage"]))).toBe(false);
    expect(canManageCompetition(null)).toBe(false);
  });
});

describe("canManageCompetitionSetup", () => {
  it("accepts only setup managers", () => {
    expect(canManageCompetitionSetup(session(["competition.manage"]))).toBe(true);
    expect(canManageCompetitionSetup(session(["*"]))).toBe(true);
    expect(canManageCompetitionSetup(session(["competition.round.prepare"]))).toBe(false);
    expect(canManageCompetitionSetup(session(["competition.score.write"]))).toBe(false);
    expect(canManageCompetitionSetup(session(["judge.manage"]))).toBe(false);
    expect(canManageCompetitionSetup(null)).toBe(false);
  });
});

describe("competition capability helpers", () => {
  it("separates prepare, resolve and session permissions", () => {
    expect(canPrepareCompetitionRound(session(["competition.round.prepare"]))).toBe(true);
    expect(canPrepareCompetitionRound(session(["competition.score.write"]))).toBe(false);
    expect(canResolveCompetition(session(["competition.score.write"]))).toBe(true);
    expect(canResolveCompetition(session(["competition.round.prepare"]))).toBe(false);
    expect(canManageLiveSession(session(["studio.manage"]))).toBe(true);
    expect(canManageLiveSession(session(["competition.score.write"]))).toBe(false);
  });
});

describe("hasLiveAccess", () => {
  it("allows every Live operator, including score writers", () => {
    expect(hasLiveAccess(session(["competition.manage"]))).toBe(true);
    expect(hasLiveAccess(session(["competition.score.write"]))).toBe(true);
    expect(hasLiveAccess(session(["judge.manage"]))).toBe(true);
    expect(hasLiveAccess(session(["*"]))).toBe(true);
  });

  it("rejects unrelated and null sessions", () => {
    expect(hasLiveAccess(session(["registration.manage"]))).toBe(false);
    expect(hasLiveAccess(null)).toBe(false);
  });
});
