import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useSearch: () => ({ next: undefined }),
}));

vi.mock("../auth/SessionProvider.js", () => ({
  defaultLanding: () => "/join",
  useSession: () => ({ session: null, login: vi.fn(), register: vi.fn() }),
}));

import { LoginPage } from "./login.js";

describe("LoginPage", () => {
  it("tells visitors that staff accounts are provisioned without exposing the deployment command", () => {
    render(<LoginPage />);
    expect(screen.getByText("工作人员账号由主办方提供，请使用收到的账号登录。")).toBeInTheDocument();
    expect(screen.queryByText(/create-account/)).not.toBeInTheDocument();
  });
});
