import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const finalizeRosterMock = vi.hoisted(() => vi.fn());
const reopenRosterMock = vi.hoisted(() => vi.fn());

vi.mock("../../api/ops.js", () => ({
  finalizeRoster: finalizeRosterMock,
  reopenRoster: reopenRosterMock,
}));

vi.mock("@tanstack/react-query", () => ({
  useMutation: (options: { readonly mutationFn: () => Promise<unknown> }) => ({
    mutate: () => {
      void options.mutationFn();
    },
    isPending: false,
    error: null,
  }),
  useQueryClient: () => ({ setQueryData: vi.fn(), invalidateQueries: vi.fn() }),
}));

import { RosterCard } from "./RosterCard.js";

const unknownRoster = { status: "unknown" as const, revision: 2 };
const finalRoster = {
  status: "final" as const,
  revision: 3,
  approvedCount: 4,
  finalizedAt: "2026-11-11T10:00:00.000Z",
};

describe("RosterCard", () => {
  beforeEach(() => {
    finalizeRosterMock.mockReset();
    reopenRosterMock.mockReset();
    finalizeRosterMock.mockResolvedValue(finalRoster);
    reopenRosterMock.mockResolvedValue(unknownRoster);
  });

  it("blocks finalization until the registration list has loaded", () => {
    render(<RosterCard activityId="activity-1" roster={unknownRoster} summary={null} />);

    expect(screen.getByRole("button", { name: "定稿名单" })).toBeDisabled();
    expect(screen.getByText("正在读取最新报名，加载完成后才能定稿。")).toBeInTheDocument();
  });

  it("blocks finalization while submissions still await review", () => {
    render(
      <RosterCard
        activityId="activity-1"
        roster={unknownRoster}
        summary={{ approved: 1, pending: 2 }}
      />,
    );

    expect(screen.getByRole("button", { name: "定稿名单" })).toBeDisabled();
    expect(screen.getByText("还有 2 条报名待审核，先审核完再定稿。")).toBeInTheDocument();
  });

  it("shows the approved count before finalizing", () => {
    render(
      <RosterCard
        activityId="activity-1"
        roster={unknownRoster}
        summary={{ approved: 3, pending: 0 }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "定稿名单" }));

    expect(screen.getByText(/将定稿 3 名已通过者/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认定稿 3 人" }));
    expect(finalizeRosterMock).toHaveBeenCalledWith("activity-1", expect.any(String), 2);
  });

  it("offers a reasoned reopen path for a final roster", () => {
    render(<RosterCard activityId="activity-1" roster={finalRoster} summary={{ approved: 4, pending: 0 }} />);

    fireEvent.click(screen.getByRole("button", { name: "重新打开名单" }));
    const confirm = screen.getByRole("button", { name: "确认重新打开" });
    expect(confirm).toBeDisabled();

    fireEvent.change(screen.getByLabelText("重新打开的原因"), {
      target: { value: "误把名单定稿成 0 人" },
    });
    fireEvent.click(confirm);

    expect(reopenRosterMock).toHaveBeenCalledWith(
      "activity-1",
      expect.any(String),
      3,
      "误把名单定稿成 0 人",
    );
  });
});
