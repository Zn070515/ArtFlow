import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const navigate = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
}));

import { CodeEntry } from "./CodeEntry.js";

beforeEach(() => {
  navigate.mockReset();
});

describe("CodeEntry", () => {
  it("rejects an empty code", () => {
    render(<CodeEntry />);
    fireEvent.submit(screen.getByRole("button", { name: "查看赛果" }).closest("form")!);
    expect(screen.getByRole("alert")).toHaveTextContent("请输入活动公开码");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("trims the code before navigating", () => {
    render(<CodeEntry />);
    fireEvent.change(screen.getByLabelText("活动公开码"), { target: { value: "  ABC123  " } });
    fireEvent.submit(screen.getByRole("button", { name: "查看赛果" }).closest("form")!);
    expect(navigate).toHaveBeenCalledWith({
      to: "/results/$publicCode",
      params: { publicCode: "ABC123" },
    });
  });
});
