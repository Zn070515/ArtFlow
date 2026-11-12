import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const reviewRegistrationMock = vi.hoisted(() => vi.fn());

vi.mock("../../api/ops.js", () => ({
  reviewRegistration: reviewRegistrationMock,
}));

vi.mock("@tanstack/react-query", () => ({
  useMutation: (options: { readonly mutationFn: (status: string) => Promise<unknown> }) => ({
    mutate: (status: string) => {
      void options.mutationFn(status);
    },
    isPending: false,
    error: null,
  }),
}));

import { ReviewPanel } from "./ReviewPanel.js";
import type { RegistrationDetail } from "../../api/registrations.js";

function detail(status: string): RegistrationDetail {
  return {
    activity: { id: "activity-1", title: "春季现场", status: "active", publicCode: "SPRING-1" },
    registration: {
      id: "registration-1",
      activityId: "activity-1",
      participantId: "alice",
      questionnaireVersion: "v1",
      questionnaireHash: "hash-1",
      status,
      answers: {},
      revision: 2,
      reviewNote: "历史意见",
    },
    questionnaire: { version: "v1", questions: [], fileSlots: [] },
    materials: [],
  };
}

describe("ReviewPanel", () => {
  beforeEach(() => {
    reviewRegistrationMock.mockReset();
    reviewRegistrationMock.mockResolvedValue({});
  });

  it("submits approve, supplement and reject with the current note", () => {
    const onReviewed = vi.fn();
    render(<ReviewPanel detail={detail("submitted")} onReviewed={onReviewed} />);

    fireEvent.change(screen.getByLabelText("审核意见"), { target: { value: "请补充伴奏" } });

    fireEvent.click(screen.getByRole("button", { name: "批准" }));
    expect(reviewRegistrationMock).toHaveBeenLastCalledWith(
      "activity-1",
      "registration-1",
      expect.any(String),
      2,
      "approved",
      "请补充伴奏",
    );

    fireEvent.click(screen.getByRole("button", { name: "需补充" }));
    expect(reviewRegistrationMock).toHaveBeenLastCalledWith(
      "activity-1",
      "registration-1",
      expect.any(String),
      2,
      "need_supplement",
      "请补充伴奏",
    );

    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
    expect(reviewRegistrationMock).toHaveBeenLastCalledWith(
      "activity-1",
      "registration-1",
      expect.any(String),
      2,
      "rejected",
      "请补充伴奏",
    );
  });

  it("does not offer review actions for a non-submitted registration", () => {
    render(<ReviewPanel detail={detail("approved")} onReviewed={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "批准" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "需补充" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "拒绝" })).not.toBeInTheDocument();
    expect(screen.getByText("当前状态「已通过」不可审核。")).toBeInTheDocument();
  });
});
