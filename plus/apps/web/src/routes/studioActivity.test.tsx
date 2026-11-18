import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useQueryMock = vi.hoisted(() => vi.fn());
const useQueryClientMock = vi.hoisted(() => vi.fn());
const useParamsMock = vi.hoisted(() => vi.fn());
const useSessionMock = vi.hoisted(() => vi.fn());
const navigateMock = vi.hoisted(() => vi.fn());
const duplicateMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({
  useQuery: useQueryMock,
  useQueryClient: useQueryClientMock,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...props }: { readonly children: ReactNode; readonly to: string; readonly [key: string]: unknown }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useParams: useParamsMock,
  useNavigate: () => navigateMock,
}));
vi.mock("../api/studio.js", () => ({
  activateStudioActivity: vi.fn(),
  duplicateStudioActivity: duplicateMock,
  fetchStudioState: vi.fn(),
  renameStudioActivity: vi.fn(),
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

function studioState(overrides: Record<string, unknown> = {}) {
  return {
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
    publicProfile: {
      activityId: "activity-1",
      tagline: "",
      description: "",
      venue: "礼堂",
      startsAt: null,
      endsAt: null,
      organizer: "学生会",
      contact: "",
      announcement: "",
      revision: 1,
      updatedBy: "ops-1",
      updatedAt: "2026-10-28T00:00:00.000Z",
    },
    ...overrides,
  };
}

function mockState(data: ReturnType<typeof studioState>): void {
  useQueryMock.mockReturnValue({ data, error: null, isPending: false });
}

describe("StudioActivityPage", () => {
  beforeEach(() => {
    useParamsMock.mockReturnValue({ activityId: "activity-1" });
    useSessionMock.mockReturnValue({ session: { actor: { permissions: ["studio.manage"], roles: [] } } });
    useQueryClientMock.mockReturnValue({ invalidateQueries: vi.fn() });
    mockState(studioState());
  });

  it("uses a Console title and separates editor from the operational rail", () => {
    render(<StudioActivityPage />);

    expect(screen.getByRole("heading", { name: "春季现场" })).toHaveClass("ui-page-title");
    expect(screen.getByRole("heading", { name: "春季现场" })).not.toHaveClass("results-title");
    expect(document.querySelector(".studio-workspace")).not.toBeNull();
    expect(document.querySelector(".studio-main-column")).not.toBeNull();
    expect(document.querySelector(".studio-rail")).not.toBeNull();
  });

  it("shows the launch readiness checklist", () => {
    render(<StudioActivityPage />);

    expect(screen.getByRole("heading", { name: "上线就绪度" })).toBeInTheDocument();
    expect(screen.getByText(/活动已就绪/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "打开 Ops" })).toBeInTheDocument();
  });

  it("keeps an archived activity read-only", () => {
    mockState(studioState({
      activity: { ...studioState().activity, status: "archived" },
    }));
    render(<StudioActivityPage />);

    expect(screen.getByText("活动已归档，配置只读。")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "打开 Ops" })).not.toBeInTheDocument();
    expect(screen.queryByText("去处理")).not.toBeInTheDocument();
  });

  it("duplicates the activity and opens the copy", async () => {
    duplicateMock.mockResolvedValue({ id: "activity-2", title: "冬季赛" });
    render(<StudioActivityPage />);

    fireEvent.click(screen.getByRole("button", { name: "复制活动" }));
    const dialog = document.querySelector("dialog") as HTMLElement;
    fireEvent.change(within(dialog).getByLabelText("新活动标题（可选）"), {
      target: { value: "冬季赛" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "复制", hidden: true }));

    await waitFor(() => {
      expect(duplicateMock).toHaveBeenCalledWith("activity-1", expect.any(String), "冬季赛");
    });
    expect(navigateMock).toHaveBeenCalledWith({
      to: "/studio/$activityId",
      params: { activityId: "activity-2" },
    });
  });
});
