import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useQueryMock = vi.hoisted(() => vi.fn());
const useQueryClientMock = vi.hoisted(() => vi.fn());
const useParamsMock = vi.hoisted(() => vi.fn());
const useSessionMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({
  useQuery: useQueryMock,
  useQueryClient: useQueryClientMock,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...props }: { readonly children: ReactNode; readonly to: string; readonly [key: string]: unknown }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useParams: useParamsMock,
}));
vi.mock("../api/live.js", () => ({ fetchLiveState: vi.fn() }));
vi.mock("../auth/RequireSession.js", () => ({
  RequireSession: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
}));
vi.mock("../auth/SessionProvider.js", () => ({
  hasLiveAccess: () => true,
  useSession: useSessionMock,
}));
vi.mock("../components/live/LiveRoundPanel.js", () => ({
  LiveRoundPanel: () => <section data-testid="live-round-panel">回合</section>,
}));
vi.mock("../components/live/LiveSessionPanel.js", () => ({
  LiveSessionPanel: () => <section data-testid="live-session-panel">会话</section>,
}));
vi.mock("../realtime/useRealtimeTopic.js", () => ({
  useRealtimeTopic: () => ({ fallback: false }),
}));

import { LiveActivityPage } from "./liveActivity.js";

describe("LiveActivityPage", () => {
  beforeEach(() => {
    useParamsMock.mockReturnValue({ activityId: "activity-1" });
    useSessionMock.mockReturnValue({ session: { actor: { permissions: ["competition.manage"], roles: [] } } });
    useQueryClientMock.mockReturnValue({ invalidateQueries: vi.fn() });
    useQueryMock.mockReturnValue({
      data: {
        activity: {
          id: "activity-1",
          title: "春季现场",
          publicCode: "SPRING-1",
          status: "active",
          revision: 2,
          enabledCapabilities: ["ticketing"],
          activeDefinitionVersion: 1,
        },
        config: { rounds: [], rubric: { criteria: [] }, tiePolicy: "hold" },
        session: null,
        rounds: [{
          config: {
            key: "round-1",
            judgeCount: 1,
            minimumJudges: 1,
            completion: "all",
            advanceCount: 1,
            scoringMethod: "sum",
          },
          round: null,
          panel: null,
          seats: [],
          performances: [],
          ranking: null,
        }],
        participantIds: ["singer-a"],
      },
      error: null,
      isPending: false,
    });
  });

  it("uses a Console header and separates rounds from the operational rail", () => {
    render(<LiveActivityPage />);

    expect(screen.getByRole("heading", { name: "春季现场" })).toHaveClass("console-page-title");
    expect(screen.getByRole("heading", { name: "春季现场" })).not.toHaveClass("results-title");
    expect(document.querySelector(".live-workspace")).not.toBeNull();
    expect(document.querySelector(".live-main-column")).not.toBeNull();
    expect(document.querySelector(".live-control-rail")).not.toBeNull();
  });
});
