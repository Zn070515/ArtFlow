import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useQueryMock = vi.hoisted(() => vi.fn());
const useQueryClientMock = vi.hoisted(() => vi.fn());
const useParamsMock = vi.hoisted(() => vi.fn());
const savePublicProfileMock = vi.hoisted(() => vi.fn());
const fetchStudioStateMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({
  useQuery: useQueryMock,
  useQueryClient: useQueryClientMock,
}));
vi.mock("@tanstack/react-router", () => ({
  useParams: useParamsMock,
  Link: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
}));
vi.mock("../api/studio.js", () => ({
  fetchStudioState: fetchStudioStateMock,
  savePublicProfile: savePublicProfileMock,
}));
vi.mock("../auth/RequireSession.js", () => ({
  RequireSession: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
}));
vi.mock("../auth/SessionProvider.js", () => ({
  hasStudioAccess: () => true,
  useSession: () => ({ session: { actor: { permissions: ["studio.manage"] } } }),
}));

import { StudioPublicProfilePage } from "./studioPublicProfile.js";

const state = {
  activity: {
    id: "activity-1",
    publicCode: "SPRING-1",
    title: "春日声场",
    status: "active",
    revision: 2,
    enabledCapabilities: ["publishing"],
    activeDefinitionVersion: 1,
  },
  draft: null,
  compiled: null,
  releases: [],
  sessions: [],
  publicProfile: {
    activityId: "activity-1",
    tagline: "春日",
    description: "介绍",
    venue: "剧场",
    startsAt: null,
    endsAt: null,
    organizer: "学生会",
    contact: "联系",
    announcement: "公告",
    revision: 1,
    updatedBy: "staff",
    updatedAt: "2026-04-01T10:00:00.000Z",
  },
};

describe("StudioPublicProfilePage", () => {
  beforeEach(() => {
    useParamsMock.mockReturnValue({ activityId: "activity-1" });
    useQueryClientMock.mockReturnValue({ invalidateQueries: vi.fn() });
    fetchStudioStateMock.mockResolvedValue(state);
    useQueryMock.mockReturnValue({ data: state, error: null, isPending: false });
    savePublicProfileMock.mockResolvedValue({ ...state.publicProfile, revision: 2 });
  });

  it("prefills the profile and saves with the current revision", async () => {
    render(<StudioPublicProfilePage />);
    expect(screen.getByLabelText("标语")).toHaveValue("春日");
    expect(screen.getByLabelText("介绍")).toHaveValue("介绍");

    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(savePublicProfileMock).toHaveBeenCalledWith("activity-1", expect.objectContaining({
      expectedRevision: 1,
      tagline: "春日",
      description: "介绍",
      venue: "剧场",
      organizer: "学生会",
      contact: "联系",
      announcement: "公告",
    })));
    expect(await screen.findByText("已保存")).toBeInTheDocument();
  });
});
