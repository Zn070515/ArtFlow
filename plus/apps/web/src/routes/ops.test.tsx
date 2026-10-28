import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useQueryMock = vi.hoisted(() => vi.fn());
const useSessionMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({
  useQuery: useQueryMock,
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...props }: { readonly children: ReactNode; readonly to: string; readonly [key: string]: unknown }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("../api/ops.js", () => ({
  fetchOpsActivities: vi.fn(),
}));

vi.mock("../auth/RequireSession.js", () => ({
  RequireSession: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
}));

vi.mock("../auth/SessionProvider.js", () => ({
  hasOpsAccess: () => true,
  useSession: useSessionMock,
}));

import { OpsPage } from "./ops.js";

describe("OpsPage", () => {
  beforeEach(() => {
    useSessionMock.mockReturnValue({ session: { actor: { permissions: ["*"], roles: ["staff"] } } });
    useQueryMock.mockReturnValue({
      data: [
        {
          id: "activity-1",
          title: "春季现场",
          publicCode: "SPRING-1",
          status: "draft",
          revision: 1,
          enabledCapabilities: [],
        },
      ],
      error: null,
      isPending: false,
    });
  });

  it("uses the compact Console page header and table overflow contract", () => {
    render(<OpsPage />);

    expect(screen.getByRole("heading", { name: "活动" })).toHaveClass("console-page-title");
    expect(screen.getByRole("heading", { name: "活动" })).not.toHaveClass("results-title");
    expect(document.querySelector(".console-table-wrap")).not.toBeNull();
  });
});
