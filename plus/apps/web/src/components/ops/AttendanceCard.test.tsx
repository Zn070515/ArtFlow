import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AttendanceListResponse } from "@artflow-plus/contracts";

const fetchAttendanceMock = vi.hoisted(() => vi.fn());
const checkInAttendanceMock = vi.hoisted(() => vi.fn());
const undoAttendanceMock = vi.hoisted(() => vi.fn());
const createAttendancePointMock = vi.hoisted(() => vi.fn());
const addAttendanceStaffMock = vi.hoisted(() => vi.fn());
const fetchExecutionsMock = vi.hoisted(() => vi.fn());
const startExecutionMock = vi.hoisted(() => vi.fn());
const closeExecutionMock = vi.hoisted(() => vi.fn());

vi.mock("../../api/attendance.js", () => ({
  fetchAttendance: fetchAttendanceMock,
  checkInAttendance: checkInAttendanceMock,
  undoAttendance: undoAttendanceMock,
  createAttendancePoint: createAttendancePointMock,
  addAttendanceStaff: addAttendanceStaffMock,
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

  it("moves the selected tab with arrow keys", async () => {
    renderCard();
    const participant = await screen.findByRole("tab", { name: "参赛者" });
    participant.focus();
    fireEvent.keyDown(participant, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "票据" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "参赛者" })).toHaveAttribute("aria-selected", "false");
  });
});
