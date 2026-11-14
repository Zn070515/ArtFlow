import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CapabilityEditor, CAPABILITY_EDITING } from "./CapabilityEditor.js";

/**
 * The domain registry is the source of truth. Keep this list in sync when a
 * capability is added: the test fails until the new key declares whether it has
 * a structured editor or deliberately no editable definition.
 */
const KNOWN_CAPABILITIES = [
  "archive",
  "attendance",
  "competition",
  "grouping",
  "incident",
  "materials",
  "publishing",
  "questionnaire",
  "registration",
  "schedule",
  "tasks",
  "ticketing",
  "voting",
];

describe("CapabilityEditor", () => {
  it("declares an editing strategy for every registered capability", () => {
    expect(Object.keys(CAPABILITY_EDITING).sort()).toEqual([...KNOWN_CAPABILITIES].sort());
  });

  it("renders a structured editor for grouping", () => {
    render(
      <CapabilityEditor
        capability="grouping"
        payload={{ schemaVersion: 1 }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("默认分组数量（可选）")).toBeInTheDocument();
  });

  it("renders a structured editor for tasks", () => {
    render(
      <CapabilityEditor
        capability="tasks"
        payload={{ schemaVersion: 1, templates: [] }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "添加模板" })).toBeInTheDocument();
  });

  it("explains configless capabilities without pointing at JSON", () => {
    render(
      <CapabilityEditor
        capability="attendance"
        payload={{ schemaVersion: 1 }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/没有可配置的定义项/)).toBeInTheDocument();
    expect(screen.queryByText(/高级 JSON/)).not.toBeInTheDocument();
  });

  it("fails closed when a capability has not declared an editing strategy", () => {
    render(
      <CapabilityEditor
        capability="future-capability"
        payload={{}}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/尚未声明结构化编辑方式/)).toBeInTheDocument();
  });
});
