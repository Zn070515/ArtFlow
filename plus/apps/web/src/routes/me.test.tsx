import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useQueryMock = vi.hoisted(() => vi.fn());
const useMutationMock = vi.hoisted(() => vi.fn());
const useQueryClientMock = vi.hoisted(() => vi.fn());
const useNavigateMock = vi.hoisted(() => vi.fn());
const markMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({
  useQuery: useQueryMock,
  useMutation: useMutationMock,
  useQueryClient: useQueryClientMock,
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: useNavigateMock,
  Link: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
}));
vi.mock("../api/me.js", () => ({
  fetchMyCenter: vi.fn(),
  markMyNotificationsRead: markMock,
}));
vi.mock("../auth/RequireSession.js", () => ({
  RequireSession: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
}));
vi.mock("../auth/SessionProvider.js", () => ({
  useSession: () => ({
    session: {
      actor: { actorId: "participant-1", actorType: "user", roles: ["participant"], permissions: [] },
      csrfToken: "csrf",
      expiresAt: "2026-11-19T00:00:00.000Z",
      mfaEnabled: false,
    },
    isLoading: false,
    login: vi.fn(),
    verifyMfa: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
  }),
}));

import { MePage } from "./me.js";

const notification = {
  key: "ME-1:registration:approved:staff:abc",
  kind: "registration" as const,
  title: "报名已通过",
  body: "你的报名已通过审核。",
  activity: { publicCode: "ME-1", title: "活动 ME-1" },
  createdAt: "2026-04-18T13:00:00.000Z",
  read: false,
  href: "/me/ME-1",
};
const event = {
  activity: {
    publicCode: "ME-1",
    title: "活动 ME-1",
    status: "active" as const,
    startsAt: null,
    endsAt: null,
    venue: "剧场",
    organizer: "学生会",
  },
  registration: {
    status: "approved" as const,
    editable: false,
    reviewNote: "欢迎",
    supplementKeys: [],
    createdAt: "2026-04-18T10:00:00.000Z",
    updatedAt: "2026-04-18T13:00:00.000Z",
  },
  materials: [{
    id: "mat-1",
    questionKey: "audio",
    originalName: "demo.mp3",
    contentType: "audio/mpeg",
    byteLength: 3,
    status: "approved" as const,
    reviewNote: "很好",
    revision: 1,
    contentPath: "/api/activities/act-me-1/materials/mat-1/content",
    reviewedAt: "2026-04-18T12:00:00.000Z",
    updatedAt: "2026-04-18T12:00:00.000Z",
  }],
  schedule: [],
  results: [],
  links: { event: "/e/ME-1", edit: null },
  archived: false,
};
const center = { events: [event], notifications: { items: [notification], unreadCount: 1 } };

describe("MePage", () => {
  beforeEach(() => {
    useNavigateMock.mockReturnValue(vi.fn());
    useQueryClientMock.mockReturnValue({ setQueryData: vi.fn(), invalidateQueries: vi.fn() });
    markMock.mockResolvedValue({ unreadCount: 0 });
    useMutationMock.mockImplementation(({ mutationFn, onSuccess }: {
      readonly mutationFn: (keys: readonly string[]) => Promise<{ unreadCount: number }>;
      readonly onSuccess?: (result: { unreadCount: number }, keys: readonly string[]) => void;
    }) => ({
      mutate: (keys: readonly string[]) => {
        void mutationFn(keys).then((result) => onSuccess?.(result, keys));
      },
      isPending: false,
    }));
    useQueryMock.mockReturnValue({ data: center, error: null, isPending: false });
  });

  it("renders events and notifications", () => {
    render(<MePage />);
    expect(screen.getByText("活动 ME-1")).toBeInTheDocument();
    expect(screen.getByText("已通过")).toBeInTheDocument();
    expect(screen.getByText("报名已通过")).toBeInTheDocument();
  });

  it("marks all notifications read", async () => {
    render(<MePage />);
    fireEvent.click(screen.getByRole("button", { name: "全部已读" }));
    await waitFor(() => expect(markMock).toHaveBeenCalledWith([notification.key]));
  });

  it("shows the empty state", () => {
    useQueryMock.mockReturnValue({
      data: { events: [], notifications: { items: [], unreadCount: 0 } },
      error: null,
      isPending: false,
    });
    render(<MePage />);
    expect(screen.getByText("还没有报名任何活动")).toBeInTheDocument();
    expect(screen.getByText("暂无通知")).toBeInTheDocument();
  });
});
