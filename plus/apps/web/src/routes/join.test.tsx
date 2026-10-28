import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useNavigateMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", () => ({ useNavigate: useNavigateMock }));

import { JoinPage } from "./join.js";

describe("JoinPage", () => {
  beforeEach(() => {
    useNavigateMock.mockReturnValue(vi.fn());
  });

  it("uses a compact Console header for the activity code form", () => {
    render(<JoinPage />);

    expect(document.querySelector(".console-page-header")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "输入活动公开码" })).toHaveClass("console-page-title");
    expect(document.querySelector(".join-code-card")).not.toBeNull();
    expect(screen.getByLabelText("活动公开码")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "继续" })).toBeInTheDocument();
  });
});
