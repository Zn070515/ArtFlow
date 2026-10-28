import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useQueryMock = vi.hoisted(() => vi.fn());
const useQueryClientMock = vi.hoisted(() => vi.fn());
const useParamsMock = vi.hoisted(() => vi.fn());
const useSessionMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({
  useQuery: useQueryMock,
  useQueryClient: useQueryClientMock,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...props }: { readonly children: ReactNode; readonly to: string; readonly [key: string]: unknown }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useParams: useParamsMock,
}));
vi.mock("../api/studio.js", () => ({
  activateStudioActivity: vi.fn(),
  fetchStudioState: vi.fn(),
}));
vi.mock("../auth/RequireSession.js", () => ({
  RequireSession: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
}));
vi.mock("../auth/SessionProvider.js", () => ({
  hasStudioAccess: () => true,
  useSession: useSessionMock,
}));
vi.mock("../components/studio/DefinitionEditor.js", () => ({ DefinitionEditor: () => <section>编辑器</section> }));
vi.mock("../components/studio/ReleasePanel.js", () => ({ ReleasePanel: () => <section>发布</section> }));
vi.mock("../components/studio/SessionPanel.js", () => ({ SessionPanel: () => <section>会话</section> }));

import { StudioActivityPage } from "./studioActivity.js";

describe("StudioActivityPage", () => {
  beforeEach(() => {
    useParamsMock.mockReturnValue({ activityId: "activity-1" });
    useSessionMock.mockReturnValue({ session: { actor: { permissions: ["studio.manage"], roles: [] } } });
    useQueryClientMock.mockReturnValue({ invalidateQueries: vi.fn() });
    useQueryMock.mockReturnValue({
      data: {
        activity: {
          id: "activity-1",
          publicCode: "SPRING-1",
          title: "春季现场",
          status: "active",
          revision: 2,
          enabledCapabilities: ["registration"],
          activeDefinitionVersion: 1,
        },
        draft: { revision: 2, package: { manifest: { key: "singer", title: "Singer Pack" } } },
        compiled: { draftRevision: 2, contentHash: "hash-1", capabilities: ["registration"] },
        releases: [{
          version: 1,
          contentHash: "hash-1",
          releasedAt: "2026-10-28T00:00:00.000Z",
          sourceDraftRevision: 2,
          declaredScopes: ["registration"],
          capabilityVersions: {},
          active: true,
        }],
        sessions: [],
      },
      error: null,
      isPending: false,
    });
  });

  it("uses a Console title and separates editor from the operational rail", () => {
    render(<StudioActivityPage />);

    expect(screen.getByRole("heading", { name: "春季现场" })).toHaveClass("console-page-title");
    expect(screen.getByRole("heading", { name: "春季现场" })).not.toHaveClass("results-title");
    expect(document.querySelector(".studio-workspace")).not.toBeNull();
    expect(document.querySelector(".studio-main-column")).not.toBeNull();
    expect(document.querySelector(".studio-rail")).not.toBeNull();
  });
});
