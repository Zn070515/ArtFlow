import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { consumeParticipantClaim } from "../api/participantClaim.js";
import { useSession } from "../auth/SessionProvider.js";
import { ClaimPage } from "./claim.js";

const navigateMock = vi.fn();
const consumeMock = vi.mocked(consumeParticipantClaim);
const useSessionMock = vi.mocked(useSession);

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
}));

vi.mock("../api/participantClaim.js", () => ({
  consumeParticipantClaim: vi.fn(),
}));

vi.mock("../auth/SessionProvider.js", () => ({
  useSession: vi.fn(),
}));

describe("ClaimPage", () => {
  beforeEach(() => {
    window.history.replaceState(window.history.state, document.title, "/claim#AF1.CLAIM.claim-1.secret");
    navigateMock.mockReset();
    useSessionMock.mockReturnValue({
      session: null,
      isLoading: false,
      login: vi.fn(),
      register: vi.fn(),
      logout: vi.fn(),
    });
    consumeMock.mockResolvedValue({
      actor: { actorId: "participant:1", actorType: "user", roles: ["participant"], permissions: [] },
      publicCode: "E2E-REG",
      csrfToken: "csrf-1",
      expiresAt: "2026-11-08T00:00:00.000Z",
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("clears the fragment and consumes a new participant claim", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ClaimPage />
      </QueryClientProvider>,
    );

    expect(window.location.hash).toBe("");
    fireEvent.change(screen.getByLabelText("用户名"), { target: { value: "claim-user" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "claim-password-123" } });
    fireEvent.change(screen.getByLabelText("确认密码"), { target: { value: "claim-password-123" } });
    fireEvent.click(screen.getByRole("button", { name: "创建账号并继续" }));

    await waitFor(() => expect(consumeMock).toHaveBeenCalledWith(
      "AF1.CLAIM.claim-1.secret",
      expect.any(String),
      { username: "claim-user", password: "claim-password-123" },
    ));
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith({
      to: "/join/$publicCode",
      params: { publicCode: "E2E-REG" },
    }));
  });

  it("shows validation for a missing token and mismatched passwords", async () => {
    window.history.replaceState(window.history.state, document.title, "/claim");
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { unmount } = render(
      <QueryClientProvider client={queryClient}>
        <ClaimPage />
      </QueryClientProvider>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("认领链接无效或已过期");
    unmount();

    window.history.replaceState(window.history.state, document.title, "/claim#AF1.CLAIM.claim-1.secret");
    render(
      <QueryClientProvider client={queryClient}>
        <ClaimPage />
      </QueryClientProvider>,
    );
    fireEvent.change(screen.getByLabelText("用户名"), { target: { value: "claim-user" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "claim-password-123" } });
    fireEvent.change(screen.getByLabelText("确认密码"), { target: { value: "different-password-123" } });
    fireEvent.click(screen.getByRole("button", { name: "创建账号并继续" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("两次输入的密码不一致");
    expect(consumeMock).not.toHaveBeenCalled();
  });
});
