import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const groupingState = vi.hoisted(() => ({ current: { stages: [] as unknown[] } }));
const participants = vi.hoisted(() => [
  {
    id: "registration-1",
    activityId: "activity-1",
    participantId: "alice",
    questionnaireVersion: "v1",
    questionnaireHash: "hash-1",
    status: "approved",
    answers: { name: "Alice" },
    revision: 1,
  },
  {
    id: "registration-2",
    activityId: "activity-1",
    participantId: "bob",
    questionnaireVersion: "v1",
    questionnaireHash: "hash-1",
    status: "approved",
    answers: { name: "Bob" },
    revision: 1,
  },
]);
const createGroupingStageMock = vi.hoisted(() => vi.fn());
const recordGroupingGroupsMock = vi.hoisted(() => vi.fn());

vi.mock("../../api/grouping.js", () => ({
  fetchGrouping: vi.fn(),
  createGroupingStage: createGroupingStageMock,
  recordGroupingGroups: recordGroupingGroupsMock,
  confirmGroupingStage: vi.fn(),
  freezeGroupingStage: vi.fn(),
  correctGroupingStage: vi.fn(),
  cancelGroupingStage: vi.fn(),
  setGroupingWindow: vi.fn(),
}));
vi.mock("../../api/ops.js", () => ({ fetchOpsRegistrations: vi.fn() }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { readonly queryKey: readonly unknown[] }) =>
    queryKey[0] === "grouping"
      ? { data: groupingState.current, isLoading: false, isError: false }
      : queryKey[0] === "live-state"
        ? { data: { rounds: [{ round: { id: "round-final", roundKey: "final" } }] }, isPending: false }
        : { data: participants, isPending: false },
  useMutation: (options: { readonly mutationFn: (arg: unknown) => Promise<unknown> }) => ({
    mutate: (arg: unknown) => {
      void options.mutationFn(arg);
    },
    isPending: false,
    error: null,
  }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

import { GroupingCard } from "./GroupingCard.js";

describe("GroupingCard", () => {
  beforeEach(() => {
    groupingState.current = { stages: [] };
    createGroupingStageMock.mockReset();
    createGroupingStageMock.mockResolvedValue({});
    recordGroupingGroupsMock.mockReset();
    recordGroupingGroupsMock.mockResolvedValue({});
  });

  it("creates the chorus grouping stage", () => {
    render(<GroupingCard activityId="activity-1" />);

    fireEvent.click(screen.getByRole("button", { name: "创建分组赛段" }));

    expect(createGroupingStageMock).toHaveBeenCalledWith("activity-1", expect.any(String), {
      stageKey: "chorus",
      name: "分组合唱",
      rosterSource: "all_approved",
    });
  });

  it("creates from a round-advanced source", () => {
    render(<GroupingCard activityId="activity-1" />);

    fireEvent.change(screen.getByLabelText("名单来源"), { target: { value: "round_advanced" } });
    fireEvent.change(screen.getByLabelText("来源回合"), { target: { value: "round-final" } });
    fireEvent.click(screen.getByRole("button", { name: "创建分组赛段" }));

    expect(createGroupingStageMock).toHaveBeenCalledWith("activity-1", expect.any(String), {
      stageKey: "chorus",
      name: "分组合唱",
      rosterSource: "round_advanced",
      sourceRoundId: "round-final",
    });
  });

  it("saves an auto-split draft and blocks confirmation until it is saved", () => {
    groupingState.current = {
      stages: [
        {
          id: "stage-1",
          stageKey: "chorus",
          name: "分组合唱",
          status: "draft",
          rosterSource: "all_approved",
          sourceRoundId: null,
          materialWindow: "closed",
          revision: 3,
          groupCount: null,
          matchesGroupCount: null,
          groups: [],
        },
      ],
    };
    render(<GroupingCard activityId="activity-1" />);

    fireEvent.click(screen.getByRole("button", { name: "自动平均分组" }));

    expect(screen.getByRole("button", { name: "确认分组" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "保存分组" }));

    expect(recordGroupingGroupsMock).toHaveBeenCalledWith(
      "activity-1",
      "stage-1",
      expect.any(String),
      3,
      expect.any(Array),
    );
  });
});
