import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useQueryMock = vi.hoisted(() => vi.fn());
const useQueryClientMock = vi.hoisted(() => vi.fn());
const useNavigateMock = vi.hoisted(() => vi.fn());
const useParamsMock = vi.hoisted(() => vi.fn());
const useSearchMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({
  useQuery: useQueryMock,
  useQueryClient: useQueryClientMock,
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: useNavigateMock,
  useParams: useParamsMock,
  useSearch: useSearchMock,
}));
vi.mock("../api/client.js", () => ({ ApiError: class ApiError extends Error { readonly status = 500; } }));
vi.mock("../api/judge.js", () => ({
  claimJudgeSeat: vi.fn(),
  fetchJudgeContext: vi.fn(),
  submitJudgeScore: vi.fn(),
}));
vi.mock("../api/live.js", () => ({ JUDGING_SCOPE: "judging" }));

import { JudgePage } from "./judge.js";

describe("JudgePage", () => {
  beforeEach(() => {
    useParamsMock.mockReturnValue({ publicCode: "SPRING-1" });
    useSearchMock.mockReturnValue({});
    useNavigateMock.mockReturnValue(vi.fn());
    useQueryClientMock.mockReturnValue({ invalidateQueries: vi.fn() });
    useQueryMock.mockReturnValue({
      data: {
        activity: { id: "activity-1", title: "春季现场", publicCode: "SPRING-1" },
        seat: { seatKey: "seat-1", state: "claimed", judgeId: "judge-1" },
        panel: { id: "panel-1", expectedJudges: 1, minimumJudges: 1, contextVersion: 1 },
        round: { id: "round-1", roundKey: "round-1", state: "scoring" },
        performance: {
          id: "performance-1",
          contestantId: "singer-a",
          sequence: 1,
          state: "open",
          contextVersion: 1,
        },
        scoring: {
          seatId: "seat-1",
          judgeId: "judge-1",
          panelSnapshotId: "panel-1",
          roundId: "round-1",
          roundKey: "round-1",
          performanceId: "performance-1",
          contextVersion: 1,
        },
        rubric: {
          criteria: [
            { key: "演唱技巧", weight: 1, minimum: 0, maximum: 100 },
            { key: "舞台表现", weight: 1, minimum: 0, maximum: 100 },
            { key: "情感表达", weight: 1, minimum: 0, maximum: 100 },
          ],
        },
        existingScore: null,
      },
      error: null,
      isPending: false,
    });
  });

  it("uses a focused Console score workspace without Portal heading styles", () => {
    render(<JudgePage />);

    expect(screen.getByRole("heading", { name: "春季现场" })).toHaveClass("console-page-title");
    expect(screen.getByRole("heading", { name: "春季现场" })).not.toHaveClass("results-title");
    expect(document.querySelector(".judge-workspace")).not.toBeNull();
    expect(document.querySelector(".judge-score-column")).not.toBeNull();
    expect(document.querySelector(".judge-status-panel")).not.toBeNull();
  });
});
