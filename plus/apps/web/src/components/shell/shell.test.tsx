import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const locationMock = vi.hoisted(() => vi.fn());
const useSessionMock = vi.hoisted(() => vi.fn());
const logoutMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...props }: { readonly children: ReactNode; readonly to: string; readonly [key: string]: unknown }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useLocation: locationMock,
}));

vi.mock("../../auth/SessionProvider.js", () => ({
  hasLiveAccess: () => true,
  hasOpsAccess: () => true,
  hasStudioAccess: () => true,
  useSession: useSessionMock,
}));

vi.mock("../hero/AuroraScene.js", () => ({
  AuroraScene: ({ reducedMotion }: { readonly reducedMotion: boolean }) => (
    <div aria-hidden="true" data-testid={reducedMotion ? "static-backdrop" : "aurora-scene"} />
  ),
}));

vi.mock("../../hooks/useReducedMotion.js", () => ({
  useReducedMotion: () => false,
}));

import { ConsoleShell } from "./ConsoleShell.js";
import { PortalShell } from "./PortalShell.js";

describe("PortalShell and ConsoleShell", () => {
  beforeEach(() => {
    locationMock.mockReturnValue({ pathname: "/ops/activity-1" });
    useSessionMock.mockReturnValue({
      session: {
        actor: { permissions: ["*"], roles: ["staff"] },
      },
      logout: logoutMock,
    });
  });

  it("renders Console navigation and marks the current section", () => {
    render(
      <ConsoleShell>
        <p>page</p>
      </ConsoleShell>,
    );

    expect(document.querySelector('[data-shell="console"][data-theme="signal"]')).not.toBeNull();
    expect(screen.getByRole("navigation", { name: "Console 主导航" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ops" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("page")).toBeInTheDocument();
  });

  it("keeps Portal branding and exposes the public navigation", () => {
    locationMock.mockReturnValue({ pathname: "/" });

    render(
      <PortalShell>
        <p>public page</p>
      </PortalShell>,
    );

    expect(document.querySelector('[data-shell="portal"][data-theme="afterglow"]')).not.toBeNull();
    expect(screen.getByLabelText("ArtFlow 赛果公示首页")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "报名" })).toBeInTheDocument();
    expect(screen.getByTestId("aurora-scene")).toBeInTheDocument();
    expect(screen.getByText("public page")).toBeInTheDocument();
  });

  it("uses a static Portal background for Vote routes", () => {
    locationMock.mockReturnValue({ pathname: "/vote/session-1" });

    render(
      <PortalShell>
        <p>vote page</p>
      </PortalShell>,
    );

    expect(document.querySelector('[data-theme="afterglow"]')).not.toBeNull();
    expect(screen.getByTestId("static-backdrop")).toBeInTheDocument();
    expect(screen.queryByTestId("aurora-scene")).not.toBeInTheDocument();
  });

  it("does not mount a decorative scene for participant claim routes", () => {
    locationMock.mockReturnValue({ pathname: "/claim" });

    render(
      <PortalShell>
        <p>claim page</p>
      </PortalShell>,
    );

    expect(screen.queryByTestId("aurora-scene")).not.toBeInTheDocument();
    expect(screen.queryByTestId("static-backdrop")).not.toBeInTheDocument();
  });

  it.each([
    ["/judge/public-code", "Judge · 评分"],
    ["/join", "报名 · 参与者"],
    ["/login", "登录"],
  ])("labels %s as %s", (pathname, label) => {
    locationMock.mockReturnValue({ pathname });

    render(
      <ConsoleShell>
        <p>page</p>
      </ConsoleShell>,
    );

    expect(screen.getByLabelText("当前工作区")).toHaveTextContent(label);
  });

  it("closes the mobile navigation with Escape and restores trigger focus", () => {
    render(
      <ConsoleShell>
        <p>page</p>
      </ConsoleShell>,
    );

    const toggle = screen.getByRole("button", { name: "打开 Console 导航" });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(document.activeElement).toBe(toggle);
  });
});
