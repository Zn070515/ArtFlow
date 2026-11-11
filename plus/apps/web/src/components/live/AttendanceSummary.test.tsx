import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AttendanceListResponse } from "@artflow-plus/contracts";

const fetchAttendanceMock = vi.hoisted(() => vi.fn());

vi.mock("../../api/attendance.js", () => ({
  fetchAttendance: fetchAttendanceMock,
}));

import { AttendanceSummary } from "./AttendanceSummary.js";

const list: AttendanceListResponse = {
  activityId: "activity-1",
  mode: "formal",
  points: [],
  staff: [],
  rows: [],
  summary: [
    { subjectType: "participant", expected: 15, present: 12, undone: 1 },
    { subjectType: "ticket", expected: 100, present: 80, undone: 0 },
    { subjectType: "staff", expected: 8, present: 7, undone: 0 },
  ],
};

describe("AttendanceSummary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders read-only attendance counts", async () => {
    fetchAttendanceMock.mockResolvedValue(list);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <AttendanceSummary activityId="activity-1" sessionMode="formal" />
      </QueryClientProvider>,
    );
    expect(await screen.findByTestId("live-attendance-summary")).toBeTruthy();
    expect(screen.getByText("参赛者：应到 15 · 已到 12 · 已撤销 1")).toBeTruthy();
    expect(screen.queryByTestId("attendance-mode-disclosure")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(fetchAttendanceMock).toHaveBeenCalledWith("activity-1", { mode: "formal" });
  });

  it("labels formal attendance while a rehearsal scoring session is running", async () => {
    fetchAttendanceMock.mockResolvedValue(list);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <AttendanceSummary activityId="activity-1" sessionMode="rehearsal" />
      </QueryClientProvider>,
    );
    expect(await screen.findByTestId("attendance-mode-disclosure")).toHaveTextContent(
      "签到没有 rehearsal 分区，当前数字是 formal。",
    );
    expect(fetchAttendanceMock).toHaveBeenCalledWith("activity-1", { mode: "formal" });
  });

  it("reads the test partition for a test scoring session", async () => {
    fetchAttendanceMock.mockResolvedValue({ ...list, mode: "test" });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <AttendanceSummary activityId="activity-1" sessionMode="test" />
      </QueryClientProvider>,
    );
    expect(await screen.findByTestId("live-attendance-summary")).toBeTruthy();
    expect(screen.queryByTestId("attendance-mode-disclosure")).toBeNull();
    expect(fetchAttendanceMock).toHaveBeenCalledWith("activity-1", { mode: "test" });
  });
});
