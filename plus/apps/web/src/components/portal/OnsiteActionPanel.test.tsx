import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, params, children }: {
    readonly to: string;
    readonly params?: Readonly<Record<string, string>>;
    readonly children: ReactNode;
  }) => <a href={to.replace(/\$publicCode/g, params?.publicCode ?? "")}>{children}</a>,
}));
vi.mock("qrcode", () => ({ toDataURL: vi.fn().mockResolvedValue("data:image/png;base64,QR") }));

import { OnsiteActions } from "./OnsiteActionPanel.js";

describe("OnsiteActions", () => {
  it("renders the primary action and secondary program entry", () => {
    render(
      <OnsiteActions
        primary="join"
        publicCode="SPRING-1"
        eventTitle="春日声场"
        voteSessionId={null}
        hasProgram
      />,
    );
    expect(screen.getByRole("link", { name: "立即报名" })).toHaveAttribute("href", "/join/SPRING-1");
    expect(screen.getByRole("link", { name: "节目单" })).toHaveAttribute("href", "#program");
    expect(screen.getByRole("button", { name: "二维码" })).toBeInTheDocument();
  });
});
