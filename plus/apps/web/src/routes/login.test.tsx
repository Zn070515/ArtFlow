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
  it("tells visitors that staff accounts are provisioned, not self-registered", () => {
    render(<LoginPage />);
    expect(screen.getByText("工作人员账号不在这里注册，由部署人员用 create-account 预先创建。")).toBeInTheDocument();
  });
});
