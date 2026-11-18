import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useQueryMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({ useQuery: useQueryMock }));

import { FeedbackCard } from "./FeedbackCard.js";

describe("FeedbackCard", () => {
  beforeEach(() => {
    useQueryMock.mockReturnValue({
      data: {
        items: [
          {
            id: "f1",
            activityId: "act-1",
            rating: 5,
            comment: "流程很顺",
            source: "public",
            submittedAt: "2026-11-18T12:00:00.000Z",
          },
          {
            id: "f2",
            activityId: "act-1",
            rating: 4,
            comment: "",
            source: "public",
            submittedAt: "2026-11-18T11:00:00.000Z",
          },
        ],
        summary: { count: 2, average: 4.5 },
      },
      error: null,
      isPending: false,
    });
  });

  it("shows the summary and recent comments", () => {
    render(<FeedbackCard activityId="act-1" />);
    expect(screen.getByText(/共 2 条 · 平均 4.5 分/)).toBeInTheDocument();
    expect(screen.getByText("流程很顺")).toBeInTheDocument();
    expect(screen.getByText("5 分")).toBeInTheDocument();
  });

  it("shows an empty state without feedback", () => {
    useQueryMock.mockReturnValue({
      data: { items: [], summary: { count: 0, average: null } },
      error: null,
      isPending: false,
    });
    render(<FeedbackCard activityId="act-1" />);
    expect(screen.getByText("还没有反馈")).toBeInTheDocument();
  });
});
