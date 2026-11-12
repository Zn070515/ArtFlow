import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const navigateMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, params, ...props }: { readonly children: ReactNode; readonly to: string; readonly params?: Record<string, string>; readonly [key: string]: unknown }) => {
    const href = Object.entries(params ?? {}).reduce(
      (value, [key, replacement]) => value.replace(`$${key}`, replacement),
      to,
    );
    return <a href={href} {...props}>{children}</a>;
  },
  useNavigate: () => navigateMock,
}));

import { ActivitySwitcher } from "./ActivitySwitcher.js";
import { WorkspaceActivityCard } from "./WorkspaceActivityCard.js";
import { WorkspaceNextAction } from "./WorkspaceNextAction.js";
import { WorkspaceProgress } from "./WorkspaceProgress.js";
import type { WorkspaceActivity, WorkspaceNextAction as NextAction, WorkspaceProgressItem } from "./workspaceState.js";

const activity: WorkspaceActivity = {
  id: "activity-1",
  title: "春季现场",
  publicCode: "SPRING-1",
  status: "active",
  revision: 2,
  enabledCapabilities: ["registration", "competition"],
};

const action: NextAction = {
  code: "REGISTRATION_REVIEW_PENDING",
  label: "处理报名审核",
  description: "还有 2 项报名需要处理。",
  target: "ops",
  count: 2,
};

const progress: readonly WorkspaceProgressItem[] = [
  { key: "setup", label: "活动配置", state: "complete", detail: "活动已激活", target: "studio" },
  { key: "registration", label: "报名", state: "complete", detail: "已有 4 份报名", target: "ops" },
  { key: "review", label: "审核与名单", state: "attention", detail: "需要检查报名和名单", target: "ops" },
];

describe("organizer workspace components", () => {
  beforeEach(() => {
    navigateMock.mockReset();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it("renders the activity card with a next action and public code", () => {
    render(<WorkspaceActivityCard activity={activity} attentionCount={2} primaryAction={action} />);

    expect(screen.getByRole("heading", { name: "春季现场" })).toBeInTheDocument();
    expect(screen.getByText("SPRING-1")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "处理报名审核" })).toHaveAttribute("href", "/ops/activity-1");
    expect(screen.getByRole("link", { name: "打开活动工作台" })).toHaveAttribute("href", "/workspace/activity-1");
  });

  it("announces successful public-code copying without hiding the code", async () => {
    render(<WorkspaceActivityCard activity={activity} attentionCount={0} primaryAction={null} />);

    fireEvent.click(screen.getByRole("button", { name: "复制公开码" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("已复制"));
    expect(screen.getByText("SPRING-1")).toBeInTheDocument();
  });

  it("renders a clear empty next-action state", () => {
    render(<WorkspaceNextAction action={null} pending={false} />);

    expect(screen.getByText("暂无待处理事项")).toBeInTheDocument();
  });

  it("renders progress as an accessible ordered list", () => {
    render(<WorkspaceProgress items={progress} />);

    expect(screen.getByRole("list", { name: "活动进度" })).toBeInTheDocument();
    expect(screen.getByText("需要检查报名和名单")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "审核与名单" })).not.toHaveClass("results-title");
  });

  it("navigates to the selected activity from the switcher", () => {
    render(<ActivitySwitcher activities={[activity]} activeActivityId={activity.id} />);

    fireEvent.change(screen.getByRole("combobox", { name: "当前活动" }), { target: { value: activity.id } });

    expect(navigateMock).toHaveBeenCalledWith({
      to: "/workspace/$activityId",
      params: { activityId: activity.id },
    });
  });
});
