import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useQueryMock = vi.hoisted(() => vi.fn());
const useSessionMock = vi.hoisted(() => vi.fn());
const access = vi.hoisted(() => ({ analytics: true }));

vi.mock("@tanstack/react-query", () => ({ useQuery: useQueryMock }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
    hash,
    ...rest
  }: {
    readonly children: ReactNode;
    readonly to: string;
    readonly params?: Readonly<Record<string, string>>;
    readonly hash?: string;
    readonly [key: string]: unknown;
  }) => {
    const path = to.replace(/\$([A-Za-z]+)/g, (_, key: string) => params?.[key] ?? `$${key}`);
    return <a href={`${path}${hash === undefined ? "" : `#${hash}`}`} {...rest}>{children}</a>;
  },
}));
vi.mock("../api/ops.js", () => ({
  fetchOperationsRisks: vi.fn(),
  fetchOpsActivities: vi.fn(),
}));
vi.mock("../auth/RequireSession.js", () => ({
  RequireSession: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
}));
vi.mock("../auth/SessionProvider.js", () => ({
  hasAnalyticsAccess: () => access.analytics,
  hasLiveAccess: () => true,
  hasOpsAccess: () => true,
  useSession: useSessionMock,
}));

import { OpsPage } from "./ops.js";

const activities = [
  {
    id: "act-1",
    publicCode: "SPRING-1",
    title: "春季赛",
    status: "active",
    revision: 1,
    enabledCapabilities: ["registration"],
  },
  {
    id: "act-2",
    publicCode: "AUTUMN-1",
    title: "秋季赛",
    status: "active",
    revision: 1,
    enabledCapabilities: ["competition"],
  },
  {
    id: "act-3",
    publicCode: "OLD-1",
    title: "旧活动",
    status: "archived",
    revision: 1,
    enabledCapabilities: [],
  },
];

const risks = {
  activities: [
    {
      activity: {
        id: "act-1",
        title: "春季赛",
        publicCode: "SPRING-1",
        status: "active",
        enabledCapabilities: ["registration"],
      },
      attention: [{ code: "REGISTRATION_REVIEW_PENDING", count: 2 }],
    },
    {
      activity: {
        id: "act-2",
        title: "秋季赛",
        publicCode: "AUTUMN-1",
        status: "active",
        enabledCapabilities: ["competition"],
      },
      attention: [],
    },
  ],
};

function mockQueries(riskOverride?: { data?: unknown; error?: unknown; isPending?: boolean }): void {
  useQueryMock.mockImplementation(({ queryKey }: { readonly queryKey: readonly unknown[] }) => {
    if (queryKey[0] === "ops-activities") {
      return { data: activities, error: null, isPending: false };
    }
    if (queryKey[0] === "ops-risks") {
      return riskOverride ?? { data: risks, error: null, isPending: false };
    }
    return { data: undefined, error: null, isPending: false };
  });
}

describe("OpsPage risk board", () => {
  beforeEach(() => {
    access.analytics = true;
    useSessionMock.mockReturnValue({
      session: { actor: { permissions: ["studio.manage"], roles: ["staff"] } },
    });
    mockQueries();
  });

  it("summarizes risk and renders the activity rows with reasons and jumps", () => {
    render(<OpsPage />);

    expect(screen.getByRole("heading", { name: "运营风险" })).toBeInTheDocument();
    const summary = screen.getByRole("heading", { name: "风险总览" }).closest(".risk-summary");
    expect(summary).toHaveTextContent("需关注 1");
    expect(summary).toHaveTextContent("就绪 1");
    expect(screen.getAllByText(/报名待审核/).length).toBeGreaterThan(0);

    const riskRow = screen.getByRole("row", { name: /春季赛/ });
    expect(riskRow).toHaveTextContent("需关注");
    expect(riskRow).toHaveTextContent("报名待审核");
    fireEvent.click(within(riskRow).getByText("查看原因"));
    expect(riskRow).toHaveTextContent("还有报名处于已提交");
    expect(within(riskRow).getByRole("link", { name: "去审核" })).toHaveAttribute(
      "href",
      "/ops/act-1#registration",
    );
  });

  it("filters to activities with risk items", () => {
    render(<OpsPage />);
    fireEvent.click(screen.getByLabelText("只看有风险"));

    expect(screen.getByRole("link", { name: "春季赛" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "秋季赛" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "旧活动" })).not.toBeInTheDocument();
  });

  it("keeps the list usable when the risk read is unavailable", () => {
    mockQueries({ data: undefined, error: new Error("forbidden"), isPending: false });
    render(<OpsPage />);

    expect(screen.getByText("风险看板暂时无法加载。")).toBeInTheDocument();
    expect(screen.getAllByText("风险未知").length).toBeGreaterThan(0);
    expect(screen.getByLabelText("只看有风险")).toBeDisabled();
    expect(screen.getByRole("link", { name: "春季赛" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "旧活动" })).toBeInTheDocument();
  });

  it("degrades without an analytics permission", () => {
    access.analytics = false;
    mockQueries({ data: undefined, error: null, isPending: false });
    render(<OpsPage />);

    expect(screen.getByText(/风险看板需要分析权限/)).toBeInTheDocument();
    expect(screen.getAllByText("风险未知").length).toBeGreaterThan(0);
    expect(screen.getByLabelText("只看有风险")).toBeDisabled();
    expect(screen.getByRole("link", { name: "春季赛" })).toBeInTheDocument();
  });

  it("shows archived activities without risk data", () => {
    render(<OpsPage />);

    const archivedRow = screen.getByRole("row", { name: /旧活动/ });
    expect(archivedRow).toHaveTextContent("已归档");
    expect(archivedRow).toHaveTextContent("—");
  });
});
