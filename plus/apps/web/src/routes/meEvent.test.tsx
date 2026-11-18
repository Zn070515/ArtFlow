import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useQueryMock = vi.hoisted(() => vi.fn());
const useParamsMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({ useQuery: useQueryMock }));
vi.mock("@tanstack/react-router", () => ({
  useParams: useParamsMock,
  Link: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
}));
vi.mock("../api/me.js", () => ({ fetchMyCenter: vi.fn() }));
vi.mock("../auth/RequireSession.js", () => ({
  RequireSession: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
}));

import { MeEventPage } from "./meEvent.js";

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
  schedule: [{
    order: 1,
    slotLabel: "第一轮",
    title: "我的节目",
    note: "",
    startsAt: "2026-04-18T11:00:00.000Z",
  }],
  results: [{
    stageKey: "final",
    publicTitle: "正式赛果",
    releasedAt: "2026-04-18T13:00:00.000Z",
    rank: 1,
    score: "98.00",
    awards: ["冠军"],
  }],
  links: { event: "/e/ME-1", edit: null },
  archived: false,
};

describe("MeEventPage", () => {
  beforeEach(() => useParamsMock.mockReturnValue({ publicCode: "ME-1" }));

  it("renders the detail sections", () => {
    useQueryMock.mockReturnValue({
      data: { events: [event], notifications: { items: [], unreadCount: 0 } },
      error: null,
      isPending: false,
    });
    render(<MeEventPage />);
    expect(screen.getByRole("heading", { name: "报名" })).toBeInTheDocument();
    expect(screen.getByText("demo.mp3")).toBeInTheDocument();
    expect(screen.getByText("我的节目")).toBeInTheDocument();
    expect(screen.getByText("第 1 名")).toBeInTheDocument();
  });

  it("shows not found for an event outside the actor's list", () => {
    useQueryMock.mockReturnValue({
      data: { events: [], notifications: { items: [], unreadCount: 0 } },
      error: null,
      isPending: false,
    });
    render(<MeEventPage />);
    expect(screen.getByText("没有找到这场活动的报名")).toBeInTheDocument();
  });
});
