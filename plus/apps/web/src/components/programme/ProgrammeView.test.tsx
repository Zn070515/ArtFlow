import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ProgrammeView } from "./ProgrammeView.js";

const published = {
  activityTitle: "2026 毕业晚会",
  publicCode: "GRAD",
  published: true,
  emptyReason: null,
  items: [
    { order: 1, title: "合唱《毕业歌》", performers: "音乐系合唱队", notes: "全体起立" },
  ],
};

describe("ProgrammeView", () => {
  it("shows the programme title for the audience and the host", () => {
    const { rerender } = render(<ProgrammeView programme={published} variant="public" />);
    expect(screen.getByRole("heading", { name: "合唱《毕业歌》" })).toBeVisible();
    rerender(<ProgrammeView programme={published} variant="host" />);
    expect(screen.getByRole("heading", { name: "合唱《毕业歌》" })).toHaveClass("cue-title");
  });

  it("keeps an unpublished show on the empty state", () => {
    render(
      <ProgrammeView
        programme={{ ...published, published: false, emptyReason: "roster_not_final", items: [] }}
        variant="host"
      />,
    );
    expect(screen.getByText(/节目单尚未发布/)).toBeVisible();
    expect(screen.queryByRole("heading", { name: "合唱《毕业歌》" })).not.toBeInTheDocument();
  });
});
