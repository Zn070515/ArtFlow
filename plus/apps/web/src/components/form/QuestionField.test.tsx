import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { QuestionField } from "./QuestionField.js";

describe("QuestionField", () => {
  it("renders a text question and reports edits", () => {
    const onChange = vi.fn();
    render(
      <QuestionField
        question={{ key: "name", label: "姓名", type: "text", required: true }}
        value=""
        onChange={onChange}
        disabled={false}
      />,
    );
    expect(screen.getByText("姓名")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Alice" } });
    expect(onChange).toHaveBeenCalledWith("Alice");
  });

  it("renders a notice without an input", () => {
    render(
      <QuestionField
        question={{ key: "notice", label: "请确认信息真实", type: "notice", required: false }}
        value=""
        onChange={() => undefined}
        disabled={false}
      />,
    );
    expect(screen.getByText("请确认信息真实")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
});
