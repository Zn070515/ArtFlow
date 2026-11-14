import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { GroupingEditor } from "./GroupingEditor.js";

describe("GroupingEditor", () => {
  it("writes a positive group count", () => {
    const onChange = vi.fn();
    render(<GroupingEditor payload={{ schemaVersion: 1 }} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText("默认分组数量（可选）"), { target: { value: "4" } });

    expect(onChange).toHaveBeenCalledWith({ schemaVersion: 1, groupCount: 4 });
  });

  it("removes the count instead of writing zero or an empty string", () => {
    const onChange = vi.fn();
    render(
      <GroupingEditor payload={{ schemaVersion: 1, groupCount: 4 }} onChange={onChange} />,
    );

    fireEvent.change(screen.getByLabelText("默认分组数量（可选）"), { target: { value: "" } });

    expect(onChange).toHaveBeenCalledWith({ schemaVersion: 1 });
  });
});
