import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const submitFeedbackMock = vi.hoisted(() => vi.fn());

vi.mock("../../api/feedback.js", () => ({ submitFeedback: submitFeedbackMock }));

import { FeedbackForm } from "./FeedbackForm.js";

describe("FeedbackForm", () => {
  beforeEach(() => {
    window.localStorage.clear();
    submitFeedbackMock.mockReset();
    submitFeedbackMock.mockResolvedValue(undefined);
  });

  it("submits the rating and comment once", async () => {
    render(<FeedbackForm publicCode="E2E-ONSITE-CLOSED" />);
    fireEvent.change(screen.getByLabelText("评分"), { target: { value: "4" } });
    fireEvent.change(screen.getByLabelText("想说的话（可选）"), {
      target: { value: "很好" },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交反馈" }));

    await waitFor(() => expect(submitFeedbackMock).toHaveBeenCalledWith(
      "E2E-ONSITE-CLOSED",
      4,
      "很好",
      "",
    ));
    expect(await screen.findByText("感谢反馈。")).toBeInTheDocument();
  });

  it("stays submitted after a remount", () => {
    window.localStorage.setItem("artflow.feedback.E2E-ONSITE-CLOSED", "1");
    render(<FeedbackForm publicCode="E2E-ONSITE-CLOSED" />);
    expect(screen.getByText("感谢反馈。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "提交反馈" })).not.toBeInTheDocument();
  });
});
