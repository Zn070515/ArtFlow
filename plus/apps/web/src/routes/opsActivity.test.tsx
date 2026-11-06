import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useQueryMock = vi.hoisted(() => vi.fn());
const useParamsMock = vi.hoisted(() => vi.fn());
const useSessionMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({
  useQuery: useQueryMock,
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...props }: { readonly children: ReactNode; readonly to: string; readonly [key: string]: unknown }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useParams: useParamsMock,
}));

vi.mock("../api/ops.js", () => ({
  fetchOpsActivities: vi.fn(),
  fetchOpsRegistrations: vi.fn(),
  fetchOpsRoster: vi.fn(),
}));
vi.mock("../api/analytics.js", () => ({ fetchActivityAnalytics: vi.fn() }));

vi.mock("../auth/RequireSession.js", () => ({
  RequireSession: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
}));

vi.mock("../auth/SessionProvider.js", () => ({
  hasOpsAccess: () => true,
  useSession: useSessionMock,
}));

vi.mock("../components/ops/GroupingCard.js", () => ({ GroupingCard: () => null }));
vi.mock("../components/ops/RegistrationTable.js", () => ({
  RegistrationTable: () => <table aria-label="报名列表" />,
}));
vi.mock("../components/ops/RosterCard.js", () => ({ RosterCard: () => <section>名单</section> }));
vi.mock("../components/ops/VotingCard.js", () => ({ VotingCard: () => null }));
vi.mock("../components/ops/ActivityAnalyticsCard.js", () => ({ ActivityAnalyticsCard: () => <section>运营分析</section> }));
vi.mock("../components/ops/TasksCard.js", () => ({
  TasksCard: ({ canManage }: { readonly canManage: boolean }) => (
    <section data-testid="tasks-card">任务卡（{canManage ? "可管理" : "只读"}）</section>
  ),
}));

import { OpsActivityPage } from "./opsActivity.js";

describe("OpsActivityPage", () => {
  beforeEach(() => {
    useParamsMock.mockReturnValue({ activityId: "activity-1" });
    useSessionMock.mockReturnValue({
      session: { actor: { permissions: ["*"], roles: ["staff"] } },
    });
    useQueryMock
      .mockReturnValueOnce({
        data: [
          {
            id: "activity-1",
            title: "春季现场",
            publicCode: "SPRING-1",
            status: "draft",
            revision: 1,
            enabledCapabilities: [],
          },
        ],
        error: null,
        isPending: false,
      })
      .mockReturnValueOnce({ data: [], error: null, isPending: false })
      .mockReturnValueOnce({
        data: { status: "unknown", revision: 1 },
        error: null,
        isPending: false,
      })
      .mockReturnValueOnce({
        data: {
          activity: { id: "activity-1", title: "春季现场", status: "draft", enabledCapabilities: [] },
          registration: { total: 0, byStatus: {} },
          materialChecks: { total: 0, byStatus: {}, requiredNotApproved: 0 },
          roster: { status: "unknown", approvedCount: null, revision: 1 },
          competition: { rounds: { total: 0, byState: {}, locked: 0 }, performances: { total: 0, byState: {}, locked: 0 }, scoreFacts: { total: 0, current: 0 } },
          voting: { sessions: { total: 0, byStatus: {} }, validBallots: 0 },
          publishing: { stageResults: { total: 0, byStatus: {}, stale: 0, confirmedWithoutActiveRelease: 0 }, resultReleases: { total: 0, byStatus: {} } },
          archive: { totalPackages: 0, currentPackages: 0 },
          attention: [],
        },
        error: null,
        isPending: false,
      });
  });

  it("uses a compact detail header and wraps the registration table", () => {
    render(<OpsActivityPage />);

    expect(screen.getByRole("heading", { name: "春季现场" })).toHaveClass("console-page-title");
    expect(screen.getByRole("heading", { name: "春季现场" })).not.toHaveClass("results-title");
    expect(document.querySelector(".console-table-wrap")).not.toBeNull();
  });

  it("mounts tasks only when the activity enables the capability", () => {
    useQueryMock.mockReset();
    useQueryMock
      .mockReturnValueOnce({
        data: [
          {
            id: "activity-1",
            title: "春季现场",
            publicCode: "SPRING-1",
            status: "draft",
            revision: 1,
            enabledCapabilities: ["tasks"],
          },
        ],
        error: null,
        isPending: false,
      })
      .mockReturnValueOnce({ data: [], error: null, isPending: false })
      .mockReturnValueOnce({ data: { status: "unknown", revision: 1 }, error: null, isPending: false })
      .mockReturnValueOnce({
        data: {
          activity: { id: "activity-1", title: "春季现场", status: "draft", enabledCapabilities: ["tasks"] },
          registration: { total: 0, byStatus: {} },
          materialChecks: { total: 0, byStatus: {}, requiredNotApproved: 0 },
          roster: { status: "unknown", approvedCount: null, revision: 1 },
          competition: { rounds: { total: 0, byState: {}, locked: 0 }, performances: { total: 0, byState: {}, locked: 0 }, scoreFacts: { total: 0, current: 0 } },
          voting: { sessions: { total: 0, byStatus: {} }, validBallots: 0 },
          publishing: { stageResults: { total: 0, byStatus: {}, stale: 0, confirmedWithoutActiveRelease: 0 }, resultReleases: { total: 0, byStatus: {} } },
          archive: { totalPackages: 0, currentPackages: 0 },
          attention: [],
        },
        error: null,
        isPending: false,
      });

    render(<OpsActivityPage />);

    expect(screen.getByTestId("tasks-card")).toHaveTextContent("可管理");
  });
});
