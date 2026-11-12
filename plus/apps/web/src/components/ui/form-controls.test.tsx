import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Input } from "./Input.js";
import { Select } from "./Select.js";
import { Textarea } from "./Textarea.js";

describe("form primitives", () => {
  it("associates an input label and error", () => {
    render(<Input label="活动名称" error="请输入名称" />);
    const input = screen.getByRole("textbox", { name: "活动名称" });
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("请输入名称");
    expect(screen.getByRole("alert")).toHaveTextContent("请输入名称");
  });

  it("renders a textarea with a label", () => {
    render(<Textarea label="备注" rows={3} />);
    expect(screen.getByRole("textbox", { name: "备注" })).toHaveClass("ui-textarea");
  });

  it("renders a select with its options", () => {
    render(
      <Select label="状态" defaultValue="draft">
        <option value="draft">草稿</option>
        <option value="active">进行中</option>
      </Select>,
    );
    const select = screen.getByRole("combobox", { name: "状态" });
    expect(select).toHaveClass("ui-select");
    expect(screen.getByRole("option", { name: "进行中" })).toBeInTheDocument();
  });
});
