import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useQueryMock = vi.hoisted(() => vi.fn());
const useQueriesMock = vi.hoisted(() => vi.fn());
const useSessionMock = vi.hoisted(() => vi.fn());
const fetchWorkspaceActivitiesMock = vi.hoisted(() => vi.fn());
const hasWorkspaceAccessMock = vi.hoisted(() => vi.fn());
const hasOpsAccessMock = vi.hoisted(() => vi.fn());
const hasStudioAccessMock = vi.hoisted(() => vi.fn());
const hasLiveAccessMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({ useQueries: useQueriesMock, useQuery: useQueryMock }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, params, ...props }: { readonly children: ReactNode; readonly to: string; readonly params?: Record<string, string>; readonly [key: string]: unknown }) => {
    const href = Object.entries(params ?? {}).reduce(
      (value, [key, replacement]) => value.replace(`$${key}`, replacement),
      to,
    );
    return <a href={href} {...props}>{children}</a>;
  },
  useParams: () => ({ activityId: "activity-1" }),
}));
vi.mock("../api/workspace.js", () => ({ fetchWorkspaceActivities: fetchWorkspaceActivitiesMock }));
vi.mock("../auth/RequireSession.js", () => ({
  RequireSession: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
}));
vi.mock("../auth/SessionProvider.js", () => ({
  hasStudioAccess: hasStudioAccessMock,
  hasOpsAccess: hasOpsAccessMock,
  hasLiveAccess: hasLiveAccessMock,
  hasWorkspaceAccess: hasWorkspaceAccessMock,
  useSession: useSessionMock,
}));
vi.mock("../components/console/ConsolePagination.js", () => ({
  ConsolePagination: () => <nav aria-label="分页" />,
}));

import { WorkspacePage } from "./workspace.js";

const activities = [
  {
    id: "activity-1",
    title: "春季现场",
    publicCode: "SPRING-1",
    status: "active",
    revision: 2,
    enabledCapabilities: ["registration"],
  },
  {
    id: "activity-2",
    title: "夏季决赛",
    publicCode: "SUMMER-2",
    status: "draft",
    revision: 1,
    enabledCapabilities: [],
  },
];

describe("WorkspacePage", () => {
  beforeEach(() => {
    useSessionMock.mockReturnValue({ session: { actor: { permissions: ["*"], roles: ["staff"] } } });
    hasWorkspaceAccessMock.mockReturnValue(true);
    hasOpsAccessMock.mockReturnValue(true);
    hasStudioAccessMock.mockReturnValue(true);
    hasLiveAccessMock.mockReturnValue(true);
    fetchWorkspaceActivitiesMock.mockResolvedValue(activities);
    useQueryMock.mockReturnValue({ data: activities, error: null, isPending: false, refetch: vi.fn() });
    useQueriesMock.mockReturnValue(activities.map(() => ({ data: null, error: null, isPending: false })));
  });

  it("renders cards and filters by activity title", () => {
    render(<WorkspacePage />);

    expect(screen.getByRole("heading", { name: "活动工作台" })).toBeInTheDocument();
    expect(screen.getByText("春季现场")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "搜索活动" }), { target: { value: "夏季" } });

    expect(screen.getByText("夏季决赛")).toBeInTheDocument();
    expect(screen.queryByText("春季现场")).not.toBeInTheDocument();
  });

  it("offers a new-activity link only when the empty workspace has Studio access", () => {
    useQueryMock.mockReturnValue({ data: [], error: null, isPending: false, refetch: vi.fn() });
    const view = render(<WorkspacePage />);

    expect(screen.getByText("还没有活动，先新建一个。")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "新建活动" })).toHaveLength(2);
    expect(screen.getAllByRole("link", { name: "新建活动" })[0]).toHaveAttribute("href", "/studio/new");

    hasStudioAccessMock.mockReturnValue(false);
    view.rerender(<WorkspacePage />);
    expect(screen.queryByRole("link", { name: "新建活动" })).not.toBeInTheDocument();
    expect(screen.getByText("当前账号还没有创建活动的权限。")).toBeInTheDocument();
  });

  it("shows a retry action when the activity list fails", () => {
    const refetch = vi.fn();
    useQueryMock.mockReturnValue({ data: undefined, error: new Error("offline"), isPending: false, refetch });
    render(<WorkspacePage />);

    expect(screen.getByRole("alert")).toHaveTextContent("活动列表暂时无法加载");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("mounts analytics queries while the activity list is pending", () => {
    useQueryMock.mockReturnValue({ data: undefined, error: null, isPending: true, refetch: vi.fn() });
    useQueriesMock.mockReturnValue([]);

    render(<WorkspacePage />);

    expect(useQueriesMock).toHaveBeenCalledWith({ queries: [] });
  });

  it("explains that a participant-only account should use the join flow", () => {
    hasWorkspaceAccessMock.mockReturnValue(false);
    render(<WorkspacePage />);

    expect(screen.getByText("当前账号没有主办方工作台权限。")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "进入报名" })).toHaveAttribute("href", "/join");
  });
});
