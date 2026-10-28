import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReadinessResponse, TaskListResponse, TaskResponse } from "@artflow-plus/contracts";

const fetchTasksMock = vi.hoisted(() => vi.fn());
const fetchReadinessMock = vi.hoisted(() => vi.fn());
const mutateTaskMock = vi.hoisted(() => vi.fn());

vi.mock("../../api/tasks.js", () => ({
  fetchTasks: fetchTasksMock,
  fetchReadiness: fetchReadinessMock,
  mutateTask: mutateTaskMock,
}));

import { TasksCard } from "./TasksCard.js";

const task: TaskResponse = {
  id: "task-1",
  activityId: "activity-1",
  definitionVersion: 1,
  templateKey: "registration.review",
  title: "完成报名审核",
  sourceCapability: "registration",
  sourceKey: "review",
  required: true,
  status: "blocked",
  assigneeActorId: "operator-1",
  dueAt: "2026-10-27T09:00:00.000Z",
  blockedReason: "等待材料补交",
  completionReason: null,
  revision: 2,
  createdAt: "2026-10-20T09:00:00.000Z",
  updatedAt: "2026-10-27T09:00:00.000Z",
};

const list: TaskListResponse = {
  activityId: "activity-1",
  definitionVersion: 1,
  tasks: [task],
};

const readiness: ReadinessResponse = {
  activityId: "activity-1",
  definitionVersion: 1,
  summary: {
    total: 1,
    required: 1,
    done: 0,
    open: 0,
    blocked: 1,
    overdue: 1,
    byStatus: { pending: 0, in_progress: 0, blocked: 1, done: 0 },
    bySourceCapability: { registration: 1 },
  },
  openTaskKeys: ["registration.review"],
};

function renderCard(canManage: boolean, taskList = list, summary = readiness): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  fetchTasksMock.mockResolvedValue(taskList);
  fetchReadinessMock.mockResolvedValue(summary);
  render(
    <QueryClientProvider client={queryClient}>
      <TasksCard activityId="activity-1" canManage={canManage} />
    </QueryClientProvider>,
  );
}

describe("TasksCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mutateTaskMock.mockReset();
  });

  it("renders task title, source, status, assignee, due time, and reasons", async () => {
    renderCard(true);

    expect(await screen.findByRole("heading", { name: "执行任务" })).toBeInTheDocument();
    expect(screen.getByText("完成报名审核")).toBeInTheDocument();
    expect(screen.getByText((_, element) => element?.textContent === "registration · review")).toBeInTheDocument();
    expect(screen.getByText("阻塞")).toBeInTheDocument();
    expect(screen.getByText("operator-1")).toBeInTheDocument();
    expect(screen.getByText("等待材料补交")).toBeInTheDocument();
    expect(screen.getAllByText(/逾期/).length).toBeGreaterThan(0);
  });

  it("renders a clear empty state when no templates are synced", async () => {
    renderCard(true, { ...list, tasks: [] }, { ...readiness, summary: { ...readiness.summary, total: 0, required: 0, open: 0, blocked: 0, overdue: 0 }, openTaskKeys: [] });

    expect(await screen.findByText("当前版本还没有同步任务模板。")).toBeInTheDocument();
  });

  it("hides mutation controls without tasks.manage", async () => {
    renderCard(false);

    expect(await screen.findByText("完成报名审核")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "开始" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "阻塞" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "完成" })).not.toBeInTheDocument();
  });

  it("renders blocked and overdue readiness summaries", async () => {
    renderCard(false);

    expect(await screen.findByText("阻塞 1")).toBeInTheDocument();
    expect(screen.getByText("逾期 1")).toBeInTheDocument();
    expect(screen.getByText("还有 1 个任务未完成")).toBeInTheDocument();
  });

  it("keeps the task context and explains a stale mutation conflict", async () => {
    mutateTaskMock.mockRejectedValueOnce(new Error("任务已被其他操作员更新") );
    const pendingTask = { ...task, status: "pending" as const, dueAt: null, blockedReason: null };
    renderCard(true, { ...list, tasks: [pendingTask] }, { ...readiness, summary: { ...readiness.summary, open: 1, blocked: 0, overdue: 0 } });

    await screen.findByText("完成报名审核");
    fireEvent.click(screen.getByRole("button", { name: "开始" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("任务已被其他操作员更新");
    expect(screen.getByText("完成报名审核")).toBeInTheDocument();
  });
});
