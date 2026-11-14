import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TasksEditor } from "./TasksEditor.js";

const template = {
  key: "confirm-roster",
  title: "确认名单",
  sourceCapability: "registration",
  sourceKey: "registration.roster.finalize",
  required: true,
};

describe("TasksEditor", () => {
  it("renders existing templates and appends a new one", () => {
    const onChange = vi.fn();
    render(
      <TasksEditor
        payload={{ schemaVersion: 1, templates: [template] }}
        onChange={onChange}
      />,
    );

    expect(screen.getByDisplayValue("confirm-roster")).toBeInTheDocument();
    expect(screen.getByDisplayValue("确认名单")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "添加模板" }));

    expect(onChange).toHaveBeenCalledWith({
      schemaVersion: 1,
      templates: [
        template,
        expect.objectContaining({ key: "task-2", required: true }),
      ],
    });
  });

  it("edits one field without dropping the other template fields", () => {
    const onChange = vi.fn();
    render(
      <TasksEditor
        payload={{ schemaVersion: 1, templates: [template] }}
        onChange={onChange}
      />,
    );

    fireEvent.change(screen.getByLabelText("模板 1 标题"), { target: { value: "核对名单" } });

    expect(onChange).toHaveBeenCalledWith({
      schemaVersion: 1,
      templates: [{ ...template, title: "核对名单" }],
    });
  });
});
