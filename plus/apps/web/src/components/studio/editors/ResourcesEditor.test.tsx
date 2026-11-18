import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ResourcesEditor } from "./ResourcesEditor.js";

describe("ResourcesEditor", () => {
  it("adds a default venue resource", () => {
    const onChange = vi.fn();
    render(<ResourcesEditor payload={{ schemaVersion: 1, resources: [] }} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "添加资源" }));
    expect(onChange).toHaveBeenCalledWith({
      schemaVersion: 1,
      resources: [{ key: "", name: "", kind: "venue", notes: "" }],
    });
  });
});
