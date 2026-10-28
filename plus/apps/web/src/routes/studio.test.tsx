import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useQueryMock = vi.hoisted(() => vi.fn());
const useSessionMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({ useQuery: useQueryMock }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...props }: { readonly children: ReactNode; readonly to: string; readonly [key: string]: unknown }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));
vi.mock("../api/studio.js", () => ({ fetchStudioActivities: vi.fn() }));
vi.mock("../auth/RequireSession.js", () => ({
  RequireSession: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
}));
vi.mock("../auth/SessionProvider.js", () => ({
  hasStudioAccess: () => true,
  useSession: useSessionMock,
}));

import { StudioPage } from "./studio.js";

describe("StudioPage", () => {
  beforeEach(() => {
    useSessionMock.mockReturnValue({ session: { actor: { permissions: ["studio.manage"], roles: [] } } });
    useQueryMock.mockReturnValue({
      data: [
        {
          id: "activity-1",
          title: "春季现场",
          publicCode: "SPRING-1",
          status: "active",
          revision: 2,
          enabledCapabilities: ["registration"],
          activeDefinitionVersion: 1,
        },
      ],
      error: null,
      isPending: false,
    });
  });

  it("uses the compact Console heading and table wrapper", () => {
    render(<StudioPage />);

    expect(screen.getByRole("heading", { name: "活动" })).toHaveClass("console-page-title");
    expect(screen.getByRole("heading", { name: "活动" })).not.toHaveClass("results-title");
    expect(document.querySelector(".console-table-wrap")).not.toBeNull();
  });
});
