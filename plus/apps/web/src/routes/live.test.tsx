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
vi.mock("../api/live.js", () => ({ fetchLiveActivities: vi.fn() }));
vi.mock("../auth/RequireSession.js", () => ({
  RequireSession: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
}));
vi.mock("../auth/SessionProvider.js", () => ({
  hasLiveAccess: () => true,
  useSession: useSessionMock,
}));

import { LivePage } from "./live.js";

describe("LivePage", () => {
  beforeEach(() => {
    useSessionMock.mockReturnValue({ session: { actor: { permissions: ["competition.manage"], roles: [] } } });
    useQueryMock.mockReturnValue({
      data: [{
        id: "activity-1",
        title: "春季现场",
        publicCode: "SPRING-1",
        status: "active",
        revision: 2,
        enabledCapabilities: ["ticketing"],
        activeDefinitionVersion: 1,
      }],
      error: null,
      isPending: false,
    });
  });

  it("uses the compact Console heading and scrollable table wrapper", () => {
    render(<LivePage />);

    expect(screen.getByRole("heading", { name: "活动" })).toHaveClass("console-page-title");
    expect(screen.getByRole("heading", { name: "活动" })).not.toHaveClass("results-title");
    expect(document.querySelector(".console-table-wrap")).not.toBeNull();
  });
});
