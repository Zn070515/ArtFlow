import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../api/teams.js", () => ({
  fetchTeams: vi.fn(async () => ({
    activityId: "act-1",
    definitionVersion: 1,
    definition: { schemaVersion: 1, minSize: 1, maxSize: 3, requireCaptain: false, source: "manual" },
    rosterFingerprint: "abcdef1234567890",
    rosterFrozen: true,
    teams: [
      {
        id: "team-1",
        teamKey: "alpha",
        name: "Alpha",
        status: "frozen",
        source: "manual",
        revision: 2,
        members: [
          { participantId: "p1", name: "选手甲", role: "member", addedAt: "2026-11-18T10:00:00.000Z" },
        ],
      },
    ],
    participants: [{ participantId: "p1", name: "选手甲" }],
  })),
  createTeam: vi.fn(),
  updateTeam: vi.fn(),
  addTeamMember: vi.fn(),
  removeTeamMember: vi.fn(),
  withdrawTeam: vi.fn(),
  freezeTeamRoster: vi.fn(),
  correctTeamRoster: vi.fn(),
  importTeamsFromGrouping: vi.fn(),
}));

import { TeamsCard } from "./TeamsCard.js";

function renderCard(permissions: readonly string[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TeamsCard activityId="act-1" permissions={permissions} />
    </QueryClientProvider>,
  );
}

describe("TeamsCard", () => {
  it("shows a frozen roster and offers correction to an authorized admin", async () => {
    renderCard(["teams.manage", "teams.roster.correct"]);
    expect(await screen.findByText("队伍与名册")).toBeInTheDocument();
    expect(await screen.findByText("Alpha")).toBeInTheDocument();
    expect(await screen.findByText("选手甲")).toBeInTheDocument();
    expect(await screen.findByText(/名册已冻结/)).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "修正名册" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "冻结名册" })).toBeNull();
  });

  it("renders nothing without a teams permission", () => {
    renderCard([]);
    expect(screen.queryByTestId("teams-card")).toBeNull();
  });
});
