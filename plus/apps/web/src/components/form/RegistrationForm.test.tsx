import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../api/registrations.js", () => ({
  saveAnswer: vi.fn(),
  submitRegistration: vi.fn(),
  uploadMaterialContent: vi.fn(),
  uploadMaterialMetadata: vi.fn(),
}));

import type { RegistrationDetail } from "../../api/registrations.js";
import { RegistrationForm } from "./RegistrationForm.js";

const detail: RegistrationDetail = {
  activity: { id: "activity-1", title: "春季现场", status: "active", publicCode: "SPRING-1" },
  registration: {
    id: "registration-1",
    activityId: "activity-1",
    participantId: "participant-1",
    questionnaireVersion: "v1",
    questionnaireHash: "hash-1",
    status: "draft",
    answers: {},
    revision: 1,
  },
  questionnaire: {
    version: "v1",
    questions: [
      { key: "name", label: "姓名", type: "text", required: true },
      { key: "song", label: "曲目", type: "text", required: true },
      { key: "notice", label: "说明", type: "notice", required: false },
      {
        key: "audio",
        label: "音频",
        type: "file",
        required: true,
        file: { slot: "audio", purpose: "演唱音频", accepts: ["audio/mpeg"] },
      },
    ],
    fileSlots: [],
  },
  materials: [],
};

describe("RegistrationForm", () => {
  it("uses a Console form workspace with full-row file slots", () => {
    render(<RegistrationForm detail={detail} onChanged={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "春季现场" })).toHaveClass("console-page-title");
    expect(screen.getByRole("heading", { name: "春季现场" })).not.toHaveClass("results-title");
    expect(document.querySelector(".registration-question-grid")).not.toBeNull();
    expect(document.querySelector(".question-file")).toHaveClass("question-full-row");
    expect(document.querySelector(".question-notice")).toHaveClass("question-full-row");
    expect(document.querySelector(".registration-actions")).not.toBeNull();
    expect(screen.getByRole("button", { name: "保存草稿" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "提交报名" })).toBeInTheDocument();
  });
});
