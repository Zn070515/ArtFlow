import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useQueryMock = vi.hoisted(() => vi.fn());
const useSessionMock = vi.hoisted(() => vi.fn());
const createAccountMock = vi.hoisted(() => vi.fn());
const updateAccountMock = vi.hoisted(() => vi.fn());
const revokeSessionsMock = vi.hoisted(() => vi.fn());
const refetchMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({
  useQuery: useQueryMock,
}));

vi.mock("../api/accounts.js", () => ({
  fetchAccounts: vi.fn(),
  createAccount: createAccountMock,
  updateAccount: updateAccountMock,
  revokeAccountSessions: revokeSessionsMock,
}));

vi.mock("../auth/RequireSession.js", () => ({
  RequireSession: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
}));

vi.mock("../auth/SessionProvider.js", () => ({
  canManageAccounts: (session: { readonly actor?: { readonly permissions?: readonly string[] } } | null) =>
    session?.actor?.permissions?.includes("account.manage") ?? false,
  useSession: useSessionMock,
}));

import { AccountsPage } from "./accounts.js";

const accounts = [
  {
    username: "account-admin",
    actorId: "account-admin-1",
    roles: ["admin"],
    permissions: ["account.manage", "studio.manage"],
    active: true,
    createdAt: "2026-11-14T00:00:00.000Z",
  },
  {
    username: "judge-one",
    actorId: "judge-one-1",
    roles: ["judge"],
    permissions: ["competition.score.write"],
    active: false,
    createdAt: "2026-11-14T00:00:00.000Z",
  },
];

describe("AccountsPage", () => {
  beforeEach(() => {
    createAccountMock.mockReset().mockResolvedValue(accounts[1]);
    updateAccountMock.mockReset().mockResolvedValue(accounts[1]);
    revokeSessionsMock.mockReset().mockResolvedValue(1);
    refetchMock.mockReset().mockResolvedValue({});
    useSessionMock.mockReturnValue({
      session: { actor: { permissions: ["account.manage"], roles: ["admin"] } },
    });
    useQueryMock.mockReturnValue({
      data: accounts,
      error: null,
      isPending: false,
      refetch: refetchMock,
    });
  });

  it("renders the account table with live permission semantics", () => {
    render(<AccountsPage />);

    expect(screen.getByRole("heading", { name: "账号与权限" })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "账号列表" })).toBeInTheDocument();
    expect(screen.getByText("account-admin")).toBeInTheDocument();
    expect(screen.getByText("已停用")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新建账号" })).toBeInTheDocument();
  });

  it("hides participant accounts until asked", () => {
    useQueryMock.mockReturnValue({
      data: [
        ...accounts,
        {
          username: "participant-one",
          actorId: "participant-one-1",
          roles: ["participant"],
          permissions: [],
          active: true,
          createdAt: "2026-11-14T00:00:00.000Z",
        },
      ],
      error: null,
      isPending: false,
      refetch: refetchMock,
    });
    render(<AccountsPage />);

    expect(screen.queryByText("participant-one")).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("显示参与者账号"));
    expect(screen.getByText("participant-one")).toBeInTheDocument();
  });

  it("does not offer account management without account.manage", () => {
    useSessionMock.mockReturnValue({
      session: { actor: { permissions: ["registration.review"], roles: ["staff"] } },
    });
    render(<AccountsPage />);

    expect(screen.getByText("没有账号管理权限")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "账号列表" })).not.toBeInTheDocument();
  });

  it("creates an account from the dialog", async () => {
    render(<AccountsPage />);

    fireEvent.click(screen.getByRole("button", { name: "新建账号" }));
    // jsdom does not implement showModal(), so the closed <dialog> stays out of
    // the accessibility tree; the create form is the first dialog in the DOM.
    const dialog = document.querySelectorAll("dialog")[0] as HTMLElement;
    fireEvent.change(within(dialog).getByLabelText("用户名"), { target: { value: "new-staff" } });
    fireEvent.change(within(dialog).getByLabelText("初始密码"), { target: { value: "staff-password" } });
    fireEvent.change(within(dialog).getByLabelText("角色"), { target: { value: "staff, judge" } });
    fireEvent.change(within(dialog).getByLabelText("权限"), { target: { value: "registration.review judges.manage" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "创建", hidden: true }));

    await waitFor(() => {
      expect(createAccountMock).toHaveBeenCalledWith({
        username: "new-staff",
        password: "staff-password",
        roles: ["staff", "judge"],
        permissions: ["registration.review", "judges.manage"],
      });
    });
    expect(refetchMock).toHaveBeenCalled();
  });
});
