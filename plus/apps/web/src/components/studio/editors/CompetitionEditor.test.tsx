import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CompetitionEditor } from "./CompetitionEditor.js";

const payload = {
  schemaVersion: 1,
  nodes: [
    { key: "roster", type: "roster" },
    { key: "final", type: "round" },
    { key: "result", type: "output" },
  ],
  edges: [
    { from: "roster", to: "final" },
    { from: "final", to: "result" },
  ],
  rounds: [{ key: "final", judgeCount: 3, minimumJudges: 2, advanceCount: 1, scoringMethod: "average" }],
  rubric: { criteria: [{ key: "演唱技巧", weight: 1, minimum: 0, maximum: 100 }] },
  tiePolicy: "review",
};

describe("CompetitionEditor", () => {
  it("edits round and rubric fields while preserving the graph", () => {
    const onChange = vi.fn();
    const view = render(<CompetitionEditor payload={payload} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText("回合 1 评委人数"), { target: { value: "5" } });
    const afterRound = onChange.mock.calls[0]?.[0] as typeof payload;
    expect(afterRound.nodes).toEqual(payload.nodes);
    expect(afterRound.edges).toEqual(payload.edges);
    expect(afterRound.rounds[0]?.judgeCount).toBe(5);

    view.rerender(<CompetitionEditor payload={afterRound} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("评分项 1 权重"), { target: { value: "0.5" } });
    const afterRubric = onChange.mock.calls[1]?.[0] as typeof payload;
    expect(afterRubric.rubric.criteria[0]?.weight).toBe(0.5);
    expect(afterRubric.rounds[0]?.judgeCount).toBe(5);
  });

  it("adds a rubric criterion without touching the graph", () => {
    const onChange = vi.fn();
    render(<CompetitionEditor payload={payload} onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: "添加评分项" }));

    const next = onChange.mock.calls[0]?.[0] as typeof payload;
    expect(next.rubric.criteria).toHaveLength(2);
    expect(next.nodes).toEqual(payload.nodes);
  });
});
