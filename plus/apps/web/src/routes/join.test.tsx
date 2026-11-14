import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useNavigateMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
    ...props
  }: {
    readonly children: ReactNode;
    readonly to: string;
    readonly params?: { readonly publicCode?: string };
    readonly [key: string]: unknown;
  }) => {
    const href =
      params?.publicCode === undefined
        ? to
        : to.replace("$publicCode", params.publicCode);
    return <a href={href} {...props}>{children}</a>;
  },
  useNavigate: useNavigateMock,
}));

import { JoinPage } from "./join.js";

describe("JoinPage", () => {
  beforeEach(() => {
    useNavigateMock.mockReturnValue(vi.fn());
    window.localStorage.clear();
  });

  it("uses a compact Console header for the activity code form", () => {
    render(<JoinPage />);

    expect(document.querySelector(".console-page-header")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "输入活动公开码" })).toHaveClass("ui-page-title");
    expect(document.querySelector(".join-code-card")).not.toBeNull();
    expect(screen.getByLabelText("活动公开码")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "继续" })).toBeInTheDocument();
  });

  it("lets a participant return to an activity they already joined", () => {
    window.localStorage.setItem(
      "artflow-joined-activities",
      JSON.stringify([{ publicCode: "E2E-REG", title: "2026 院十佳报名", joinedAt: "2026-11-14T00:00:00.000Z" }]),
    );
    render(<JoinPage />);

    expect(screen.getByRole("heading", { name: "最近报名" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "2026 院十佳报名" })).toHaveAttribute("href", "/join/E2E-REG");
  });
});
