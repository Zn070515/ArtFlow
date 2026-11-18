import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useQueryMock = vi.hoisted(() => vi.fn());
const useMutationMock = vi.hoisted(() => vi.fn());
const useQueryClientMock = vi.hoisted(() => vi.fn());
const fetchScheduleMock = vi.hoisted(() => vi.fn());
const upsertScheduleEntryMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({
  useQuery: useQueryMock,
  useMutation: useMutationMock,
  useQueryClient: useQueryClientMock,
}));
vi.mock("../../api/schedule.js", () => ({
  advanceSchedule: vi.fn(),
  fetchSchedule: fetchScheduleMock,
  releaseSchedule: vi.fn(),
  removeScheduleEntry: vi.fn(),
  reorderSchedule: vi.fn(),
  revokeScheduleRelease: vi.fn(),
  upsertScheduleEntry: upsertScheduleEntryMock,
}));
vi.mock("../../api/voting.js", () => ({
  closeExecution: vi.fn(),
  fetchExecutions: vi.fn(),
  startExecution: vi.fn(),
}));

import { ScheduleCard } from "./ScheduleCard.js";

describe("ScheduleCard", () => {
  beforeEach(() => {
    useQueryClientMock.mockReturnValue({ invalidateQueries: vi.fn() });
    useMutationMock.mockReturnValue({ mutate: vi.fn(), isPending: false, error: null });
    fetchScheduleMock.mockResolvedValue({});
    upsertScheduleEntryMock.mockResolvedValue({});
    useQueryMock.mockImplementation(({ queryKey }: { readonly queryKey: readonly unknown[] }) => {
      if (queryKey[0] === "schedule") {
        return {
          data: {
            revision: 3,
            entries: [{
              id: "entry-1",
              activityId: "act-1",
              mode: "formal",
              position: 0,
              slotKey: "opening",
              slotLabel: "开场",
              participantId: null,
              title: "开场舞",
              note: "",
              startsAt: "2026-04-18T11:00:00.000Z",
              revision: 1,
              createdAt: "",
              updatedAt: "",
            }],
            releases: [],
            currentEntryId: null,
            slots: [{ key: "opening", label: "开场", durationMinutes: 10, kind: "program" }],
          },
          error: null,
          isPending: false,
        };
      }
      return { data: [], error: null, isPending: false };
    });
  });

  it("shows the start time and saves an inline edit", async () => {
    render(<ScheduleCard activityId="act-1" canManage />);
    const entry = screen.getByTestId("schedule-entry");
    expect(within(entry).getByText(/开场舞/)).toBeInTheDocument();
    expect(within(entry).getByText(/2026/)).toBeInTheDocument();

    fireEvent.click(within(entry).getByRole("button", { name: "编辑" }));
    fireEvent.change(within(entry).getByLabelText("节目名称"), { target: { value: "开场舞 2" } });
    fireEvent.click(within(entry).getByRole("button", { name: "保存" }));

    await waitFor(() => expect(upsertScheduleEntryMock).toHaveBeenCalledWith("act-1", expect.objectContaining({
      entryId: "entry-1",
      title: "开场舞 2",
      startsAt: "2026-04-18T11:00:00.000Z",
    })));
  });
});
