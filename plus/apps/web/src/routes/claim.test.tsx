import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const navigateMock = vi.hoisted(() => vi.fn());
const previewMock = vi.hoisted(() => vi.fn());
const claimMock = vi.hoisted(() => vi.fn());
const setQueryDataMock = vi.hoisted(() => vi.fn());
const removeQueriesMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({
    setQueryData: setQueryDataMock,
    removeQueries: removeQueriesMock,
  }),
}));
vi.mock("../api/auth.js", () => ({
  previewInvite: previewMock,
  claimInvite: claimMock,
}));

import { ClaimPage } from "./claim.js";

describe("ClaimPage", () => {
  beforeEach(() => {
    navigateMock.mockReset();
    previewMock.mockReset().mockResolvedValue({
      username: "invited-user",
      expiresAt: "2026-11-17T00:00:00.000Z",
    });
    claimMock.mockReset().mockResolvedValue({
      actor: { actorId: "user:invited-user", roles: ["staff"], permissions: [] },
      csrfToken: "csrf",
      expiresAt: "2026-11-17T00:00:00.000Z",
    });
    setQueryDataMock.mockReset();
    removeQueriesMock.mockReset();
  });

  function renderWithToken(token: string): void {
    window.history.replaceState(null, "", `/claim#${token}`);
    render(<ClaimPage />);
  }

  it("reads the fragment, clears it, and shows the invited account", async () => {
    renderWithToken("token-1");

    expect(await screen.findByText(/账号 invited-user/)).toBeInTheDocument();
    expect(previewMock).toHaveBeenCalledWith("token-1");
    expect(window.location.hash).toBe("");
  });

  it("claims the invitation and navigates to the workspace", async () => {
    renderWithToken("token-1");
    await screen.findByText(/账号 invited-user/);

    fireEvent.change(screen.getByLabelText("新密码"), {
      target: { value: "invite-password-123" },
    });
    fireEvent.change(screen.getByLabelText("再次输入密码"), {
      target: { value: "invite-password-123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "设置密码并登录" }));

    await waitFor(() => {
      expect(claimMock).toHaveBeenCalledWith("token-1", "invite-password-123");
    });
    expect(setQueryDataMock).toHaveBeenCalledWith(["me"], expect.objectContaining({
      actor: expect.objectContaining({ actorId: "user:invited-user" }),
    }));
    expect(navigateMock).toHaveBeenCalledWith({ to: "/workspace" });
  });

  it("shows an empty state when the link carries no token", () => {
    window.history.replaceState(null, "", "/claim");
    render(<ClaimPage />);

    expect(screen.getByText("邀请链接无效")).toBeInTheDocument();
    expect(previewMock).not.toHaveBeenCalled();
  });
});
