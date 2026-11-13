import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AttendanceListResponse } from "@artflow-plus/contracts";

const fetchAttendanceMock = vi.hoisted(() => vi.fn());
const checkInAttendanceMock = vi.hoisted(() => vi.fn());
const undoAttendanceMock = vi.hoisted(() => vi.fn());
const createAttendancePointMock = vi.hoisted(() => vi.fn());
const addAttendanceStaffMock = vi.hoisted(() => vi.fn());
const updateAttendancePointMock = vi.hoisted(() => vi.fn());
const updateAttendanceStaffMock = vi.hoisted(() => vi.fn());
const fetchExecutionsMock = vi.hoisted(() => vi.fn());
const startExecutionMock = vi.hoisted(() => vi.fn());
const closeExecutionMock = vi.hoisted(() => vi.fn());

vi.mock("../../api/attendance.js", () => ({
  fetchAttendance: fetchAttendanceMock,
  checkInAttendance: checkInAttendanceMock,
  undoAttendance: undoAttendanceMock,
  createAttendancePoint: createAttendancePointMock,
  addAttendanceStaff: addAttendanceStaffMock,
  updateAttendancePoint: updateAttendancePointMock,
  updateAttendanceStaff: updateAttendanceStaffMock,
}));

vi.mock("../../api/voting.js", () => ({
  fetchExecutions: fetchExecutionsMock,
  startExecution: startExecutionMock,
  closeExecution: closeExecutionMock,
}));

import { AttendanceCard } from "./AttendanceCard.js";

const list: AttendanceListResponse = {
  activityId: "activity-1",
  mode: "formal",
  points: [{
    id: "point-1",
    key: "gate",
    name: "入口",
    subjectTypes: ["participant", "ticket", "staff"],
    active: true,
    revision: 0,
  }],
  staff: [],
  rows: [{
    pointKey: "gate",
    subjectType: "participant",
    subjectId: "registration-1",
    label: "选手甲",
    eligible: true,
    status: "not_checked_in",
    note: null,
    updatedAt: null,
  }],
  summary: [
    { subjectType: "participant", expected: 1, present: 0, undone: 0 },
    { subjectType: "ticket", expected: 0, present: 0, undone: 0 },
    { subjectType: "staff", expected: 0, present: 0, undone: 0 },
  ],
};

function renderCard(
  options: { canManage?: boolean; canManageSession?: boolean } = {},
  attendanceList: AttendanceListResponse = list,
): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  fetchAttendanceMock.mockResolvedValue(attendanceList);
  fetchExecutionsMock.mockResolvedValue([{
    id: "session-1",
    activityId: "activity-1",
    definitionVersion: 1,
    scope: "checkin",
    mode: "formal",
    status: "running",
    revision: 1,
  }]);
  checkInAttendanceMock.mockResolvedValue({});
  undoAttendanceMock.mockResolvedValue({});
  updateAttendancePointMock.mockResolvedValue(list.points[0]);
  updateAttendanceStaffMock.mockResolvedValue({
    id: "staff-1",
    displayName: "工作人员",
    actorId: null,
    active: true,
    revision: 0,
  });
  render(
    <QueryClientProvider client={queryClient}>
      <AttendanceCard
        activityId="activity-1"
        canManage={options.canManage ?? true}
        canManageSession={options.canManageSession ?? true}
      />
    </QueryClientProvider>,
  );
}

describe("AttendanceCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows the summary and checks in an expected subject", async () => {
    renderCard();
    expect(await screen.findByTestId("attendance-card")).toBeTruthy();
    expect(await screen.findByText("应到 1 · 已到 0 · 已撤销 0")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "签到" }));
    await waitFor(() => expect(checkInAttendanceMock).toHaveBeenCalledWith("activity-1", {
      pointKey: "gate",
      subjectType: "participant",
      subjectId: "registration-1",
    }));
  });

  it("hides write controls without attendance.manage", async () => {
    renderCard({ canManage: false, canManageSession: false });
    expect(await screen.findByTestId("attendance-card")).toBeTruthy();
    expect(screen.queryByTestId("attendance-session")).toBeNull();
    expect(screen.queryByTestId("attendance-management")).toBeNull();
    expect(screen.queryByRole("button", { name: "签到" })).toBeNull();
  });

  it("offers undo for a present subject", async () => {
    renderCard({}, {
      ...list,
      rows: [{ ...list.rows[0]!, status: "present" as const }],
      summary: [{ subjectType: "participant", expected: 1, present: 1, undone: 0 }],
    });
    expect(await screen.findByTestId("attendance-card")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "撤销" }));
    await waitFor(() => expect(undoAttendanceMock).toHaveBeenCalledWith("activity-1", {
      pointKey: "gate",
      subjectType: "participant",
      subjectId: "registration-1",
    }));
  });

  it("shows a loading state instead of an empty state while switching tabs", async () => {
    let resolveSecond: ((value: AttendanceListResponse) => void) | undefined;
    fetchAttendanceMock.mockResolvedValueOnce(list);
    fetchAttendanceMock.mockImplementationOnce(
      () => new Promise<AttendanceListResponse>((resolve) => { resolveSecond = resolve; }),
    );
    renderCard();
    await screen.findByTestId("attendance-card");
    fireEvent.click(screen.getByRole("tab", { name: "票据" }));
    expect(await screen.findByText("正在加载…")).toBeInTheDocument();
    expect(screen.queryByText("当前筛选下没有主体。")).toBeNull();
    resolveSecond?.({
      ...list,
      rows: [],
      summary: [{ subjectType: "ticket", expected: 0, present: 0, undone: 0 }],
    });
    await waitFor(() => expect(screen.getByText("当前筛选下没有主体。")).toBeInTheDocument());
  });

  it("disables stale row actions while a new filter loads", async () => {
    let resolveSecond: ((value: AttendanceListResponse) => void) | undefined;
    fetchAttendanceMock.mockResolvedValueOnce(list);
    fetchAttendanceMock.mockImplementationOnce(
      () => new Promise<AttendanceListResponse>((resolve) => { resolveSecond = resolve; }),
    );
    renderCard();
    await screen.findByText("选手甲");
    fireEvent.change(screen.getByLabelText("搜索"), { target: { value: "nobody" } });
    expect(await screen.findByText("正在加载…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "签到" })).toBeDisabled();
    resolveSecond?.({ ...list, rows: [] });
  });

  it("edits an existing attendance point through the expected revision", async () => {
    renderCard();
    await screen.findByTestId("attendance-management");
    fireEvent.change(screen.getByLabelText("编辑签到点"), { target: { value: "gate" } });
    fireEvent.change(screen.getByLabelText("签到点新名称"), { target: { value: "正门" } });
    fireEvent.click(screen.getByRole("button", { name: "保存签到点" }));
    await waitFor(() => expect(updateAttendancePointMock).toHaveBeenCalledWith("activity-1", "gate", {
      expectedRevision: 0,
      name: "正门",
      subjectTypes: ["participant", "ticket", "staff"],
      active: true,
    }));
  });

  it("moves the selected tab with arrow keys", async () => {
    renderCard();
    const participant = await screen.findByRole("tab", { name: "参赛者" });
    participant.focus();
    fireEvent.keyDown(participant, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "票据" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "参赛者" })).toHaveAttribute("aria-selected", "false");
  });
});
