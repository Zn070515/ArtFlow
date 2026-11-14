import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { QuestionnaireEditor } from "./QuestionnaireEditor.js";

describe("QuestionnaireEditor", () => {
  it("edits one question without losing the other questions or file slots", () => {
    const onChange = vi.fn();
    render(
      <QuestionnaireEditor
        payload={{
          schemaVersion: 1,
          version: "v1",
          questions: [
            { key: "name", label: "姓名", type: "text", required: true },
            {
              key: "audio",
              label: "音频材料",
              type: "file",
              required: true,
              file: { slot: "audio", purpose: "audio", accepts: [".mp3"], maxBytes: 1024 },
            },
          ],
        }}
        onChange={onChange}
      />,
    );

    fireEvent.change(screen.getByLabelText("问题 1 标题"), { target: { value: "真实姓名" } });

    expect(onChange).toHaveBeenCalled();
    const payload = onChange.mock.calls[0]?.[0] as {
      version: string;
      questions: { key: string; label: string; file?: { accepts: string[] } }[];
    };
    expect(payload.version).toBe("v1");
    expect(payload.questions[0]?.label).toBe("真实姓名");
    expect(payload.questions[1]?.file?.accepts).toEqual([".mp3"]);
  });

  it("creates a file slot when the type changes to file", () => {
    const onChange = vi.fn();
    render(
      <QuestionnaireEditor
        payload={{ schemaVersion: 1, version: "v1", questions: [{ key: "work", label: "作品", type: "text" }] }}
        onChange={onChange}
      />,
    );

    fireEvent.change(screen.getByLabelText("问题 1 类型"), { target: { value: "file" } });

    const payload = onChange.mock.calls[0]?.[0] as {
      questions: { file?: { slot: string; accepts: string[] } }[];
    };
    expect(payload.questions[0]?.file?.slot).toBe("work");
    expect(payload.questions[0]?.file?.accepts).toEqual([".pdf"]);
  });
});
