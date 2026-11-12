import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useQueryMock = vi.hoisted(() => vi.fn());
const useSessionMock = vi.hoisted(() => vi.fn());
const hasWorkspaceAccessMock = vi.hoisted(() => vi.fn());
const hasOpsAccessMock = vi.hoisted(() => vi.fn());
const hasStudioAccessMock = vi.hoisted(() => vi.fn());
const hasLiveAccessMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({ useQuery: useQueryMock }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, params, ...props }: { readonly children: ReactNode; readonly to: string; readonly params?: Record<string, string>; readonly [key: string]: unknown }) => {
    const href = Object.entries(params ?? {}).reduce(
      (value, [key, replacement]) => value.replace(`$${key}`, replacement),
      to,
    );
    return <a href={href} {...props}>{children}</a>;
  },
  useNavigate: () => vi.fn(),
  useParams: () => ({ activityId: "activity-1" }),
}));
vi.mock("../api/workspace.js", () => ({
  fetchWorkspaceActivities: vi.fn(),
  fetchWorkspaceAnalytics: vi.fn(),
  fetchWorkspaceLiveState: vi.fn(),
  fetchWorkspaceStudioState: vi.fn(),
}));
vi.mock("../auth/RequireSession.js", () => ({
  RequireSession: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
}));
vi.mock("../auth/SessionProvider.js", () => ({
  hasLiveAccess: hasLiveAccessMock,
  hasOpsAccess: hasOpsAccessMock,
  hasStudioAccess: hasStudioAccessMock,
  hasWorkspaceAccess: hasWorkspaceAccessMock,
  useSession: useSessionMock,
}));

import { WorkspaceActivityPage } from "./workspaceActivity.js";

const activity = {
  id: "activity-1",
  title: "春季现场",
  publicCode: "SPRING-1",
  status: "active",
  revision: 2,
  enabledCapabilities: ["registration", "competition", "publishing"],
};

const analytics = {
  activity: { id: "activity-1", title: "春季现场", status: "active", enabledCapabilities: activity.enabledCapabilities },
  registration: { total: 2, byStatus: { submitted: 2 } },
  materialChecks: { total: 0, byStatus: {}, requiredNotApproved: 0 },
  roster: { status: "unknown", approvedCount: null, revision: 1 },
  competition: { rounds: { total: 0, byState: {}, locked: 0 }, performances: { total: 0, byState: {}, locked: 0 }, scoreFacts: { total: 0, current: 0 } },
  voting: { sessions: { total: 0, byStatus: {} }, validBallots: 0 },
  publishing: { stageResults: { total: 0, byStatus: {}, stale: 0, confirmedWithoutActiveRelease: 0 }, resultReleases: { total: 0, byStatus: {} } },
  archive: { totalPackages: 0, currentPackages: 0 },
  attention: [{ code: "REGISTRATION_REVIEW_PENDING", severity: "warning", count: 2 }],
};

function queryState(overrides: Record<string, unknown> = {}) {
  return { data: undefined, error: null, isPending: false, ...overrides };
}

describe("WorkspaceActivityPage", () => {
  beforeEach(() => {
    useSessionMock.mockReturnValue({ session: { actor: { permissions: ["*"], roles: ["staff"] } } });
    hasWorkspaceAccessMock.mockReturnValue(true);
    hasOpsAccessMock.mockReturnValue(true);
    hasStudioAccessMock.mockReturnValue(true);
    hasLiveAccessMock.mockReturnValue(true);
    useQueryMock.mockImplementation(({ queryKey }: { readonly queryKey: readonly unknown[] }) => {
      const key = queryKey.join(":");
      if (key === "workspace-activities") return queryState({ data: [activity] });
      if (key === "workspace-analytics:activity-1") return queryState({ data: analytics });
      if (key === "workspace-studio:activity-1") return queryState({ data: null });
      if (key === "workspace-live:activity-1") return queryState({ data: null });
      return queryState();
    });
  });

  it("renders the activity identity and attention-driven next action", () => {
    render(<WorkspaceActivityPage />);

    expect(screen.getByRole("heading", { name: "春季现场" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "处理报名审核" })).toBeInTheDocument();
    expect(screen.getByText("还有 2 项报名需要处理。")).toBeInTheDocument();
  });

  it("keeps identity and quick links visible when analytics fails", () => {
    useQueryMock.mockImplementation(({ queryKey }: { readonly queryKey: readonly unknown[] }) => {
      const key = queryKey.join(":");
      if (key === "workspace-activities") return queryState({ data: [activity] });
      if (key === "workspace-analytics:activity-1") return queryState({ error: new Error("offline") });
      if (key === "workspace-studio:activity-1") return queryState({ data: null });
      if (key === "workspace-live:activity-1") return queryState({ data: null });
      return queryState();
    });

    render(<WorkspaceActivityPage />);

    expect(screen.getByRole("heading", { name: "春季现场" })).toBeInTheDocument();
    expect(screen.getByText("运营摘要暂不可用")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "进入 Ops" })).toHaveAttribute("href", "/ops/activity-1");
  });

  it("does not expose organizer links that the actor cannot access", () => {
    hasOpsAccessMock.mockReturnValue(false);
    hasLiveAccessMock.mockReturnValue(false);

    render(<WorkspaceActivityPage />);

    expect(screen.getByRole("link", { name: "进入 Studio" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "进入 Ops" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "进入 Live" })).not.toBeInTheDocument();
    expect(screen.getByText("该活动已启用 Live，但当前账号没有现场权限。")).toBeInTheDocument();
  });

  it("only exposes public results after an active release exists", () => {
    render(<WorkspaceActivityPage />);

    expect(screen.queryByRole("link", { name: "查看公开赛果" })).not.toBeInTheDocument();
  });

  it("shows an unavailable state for an unknown activity", () => {
    useQueryMock.mockImplementation(({ queryKey }: { readonly queryKey: readonly unknown[] }) => {
      if (queryKey.join(":") === "workspace-activities") return queryState({ data: [] });
      return queryState();
    });

    render(<WorkspaceActivityPage />);

    expect(screen.getByRole("heading", { name: "活动不可用" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回活动工作台" })).toHaveAttribute("href", "/workspace");
  });
});
