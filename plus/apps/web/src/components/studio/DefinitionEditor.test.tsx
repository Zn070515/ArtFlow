import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const compileMock = vi.hoisted(() => vi.fn());

vi.mock("../../api/studio.js", () => ({
  compileStudioDefinition: compileMock,
}));

import type { StudioState } from "../../api/studio.js";
import { DefinitionEditor } from "./DefinitionEditor.js";

const state: StudioState = {
  activity: {
    id: "activity-1",
    publicCode: "SPRING-1",
    title: "春季现场",
    status: "active",
    revision: 2,
    enabledCapabilities: ["registration", "questionnaire"],
    activeDefinitionVersion: 1,
  },
  draft: {
    revision: 3,
    package: {
      schemaVersion: 1,
      manifest: { key: "spring", title: "春季现场" },
      capabilities: {
        registration: {
          schemaVersion: 1,
          payload: { schemaVersion: 1, lifecycleVersion: 1, lifecycle: "open" },
        },
        questionnaire: {
          schemaVersion: 1,
          payload: {
            schemaVersion: 1,
            version: "v1",
            questions: [{ key: "name", label: "姓名", type: "text", required: true }],
          },
        },
      },
      bindings: [],
      futureField: { keep: true },
    },
  },
  compiled: null,
  releases: [],
  sessions: [],
};

describe("DefinitionEditor Professional Mode", () => {
  it("edits a capability structurally and keeps the rest of the package", async () => {
    compileMock.mockResolvedValue({ contentHash: "hash-123456789012" });
    render(<DefinitionEditor state={state} onChanged={vi.fn()} />);

    expect(screen.getByRole("tab", { name: "结构化" })).toHaveAttribute("aria-selected", "true");
    fireEvent.change(screen.getByLabelText("报名生命周期"), { target: { value: "final" } });

    fireEvent.click(screen.getByRole("tab", { name: "高级 JSON" }));
    const json = screen.getByLabelText("Definition Package JSON") as HTMLTextAreaElement;
    const parsed = JSON.parse(json.value) as {
      capabilities: { registration: { payload: { lifecycle: string } } };
      futureField: { keep: boolean };
      bindings: unknown[];
    };
    expect(parsed.capabilities.registration.payload.lifecycle).toBe("final");
    expect(parsed.futureField).toEqual({ keep: true });
    expect(parsed.bindings).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "编译定义" }));
    await waitFor(() => expect(compileMock).toHaveBeenCalled());
    const call = compileMock.mock.calls[0] as [string, string, unknown, number];
    expect(call[0]).toBe("activity-1");
    expect(call[3]).toBe(3);
    expect((call[2] as typeof parsed).capabilities.registration.payload.lifecycle).toBe("final");
  });
});
