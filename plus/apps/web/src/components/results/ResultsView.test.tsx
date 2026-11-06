import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { PublicResults } from "../../api/public-results.js";
import { formatReleasedAt, ResultsView } from "./ResultsView.js";

const data: PublicResults = {
  activity: { publicCode: "ABC123" },
  activityTitle: "2026 院十佳",
  results: [
    {
      releaseId: "release-1",
      stageKey: "final_podium",
      publicTitle: "2026 院十佳 · 正式赛果",
      releasedAt: "2026-10-20T18:00:00.000Z",
      decisions: [
        { rank: 1, contestantId: "singer-a", score: "98.30" },
        { rank: 2, contestantId: "singer-b", score: "97.80" },
      ],
      awards: [{ award: "冠军", contestantId: "singer-a" }],
    },
  ],
};

describe("ResultsView", () => {
  it("renders the frozen public identity and ranking", () => {
    render(<ResultsView data={data} />);
    expect(screen.getByRole("heading", { name: "2026 院十佳" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "2026 院十佳 · 正式赛果" })).toBeInTheDocument();
    const rows = screen.getAllByRole("listitem");
    expect(within(rows[0]!).getByText("singer-a")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("97.80")).toBeInTheDocument();
    expect(screen.getByText("冠军")).toBeInTheDocument();
  });

  it("formats the release timestamp", () => {
    expect(formatReleasedAt("2026-10-20T18:00:00.000Z")).toContain("2026");
  });
});

it("renders a percent unit without the score suffix", () => {
  render(
    <ResultsView
      data={{
        activity: { publicCode: "VOTE-1" },
        activityTitle: "人气投票",
        results: [
          {
            releaseId: "release-1",
            stageKey: "vote_result",
            publicTitle: "人气投票 · 投票结果",
            releasedAt: "2026-10-27T10:00:00Z",
            decisions: [
              { rank: 1, contestantId: "candidate-a", score: "66.67", unit: "percent" },
            ],
            awards: [],
          },
        ],
      }}
    />,
  );
  expect(screen.getByText("66.67%")).toBeInTheDocument();
  expect(screen.getByText(/第 1 名.*candidate-a.*66\.67%/)).toBeInTheDocument();
});
