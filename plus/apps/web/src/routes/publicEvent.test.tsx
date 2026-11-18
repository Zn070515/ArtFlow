import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useQueryMock = vi.hoisted(() => vi.fn());
const useParamsMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({ useQuery: useQueryMock }));
vi.mock("@tanstack/react-router", () => ({
  useParams: useParamsMock,
  Link: ({ to, params, children }: {
    readonly to: string;
    readonly params?: Readonly<Record<string, string>>;
    readonly children: ReactNode;
  }) => (
    <a href={to.replace(/\$publicCode/g, params?.publicCode ?? "")}>{children}</a>
  ),
}));
vi.mock("../api/publicEvent.js", () => ({
  fetchPublicEvent: vi.fn(),
  PublicEventNotFound: class PublicEventNotFound extends Error {},
}));
vi.mock("qrcode", () => ({ toDataURL: vi.fn().mockResolvedValue("data:image/png;base64,QR") }));

import { ApiError } from "../api/client.js";
import { PublicEventNotFound } from "../api/publicEvent.js";
import { PublicEventPage } from "./publicEvent.js";

const site = {
  activity: {
    publicCode: "SPRING-1",
    title: "春日声场",
    status: "active" as const,
    registrationEnabled: true,
    registrationOpen: true,
  },
  profile: {
    tagline: "春日",
    description: "介绍",
    venue: "剧场",
    startsAt: "2026-04-18T11:00:00.000Z",
    endsAt: null,
    organizer: "学生会",
    contact: "联系",
    announcement: "公告",
  },
  schedule: {
    entries: [{
      order: 1,
      slotLabel: "开场",
      title: "开场舞",
      note: "",
      startsAt: "2026-04-18T11:00:00.000Z",
    }],
  },
  program: null,
  results: {
    activityTitle: "春日声场",
    results: [{
      stageKey: "final",
      publicTitle: "正式赛果",
      releasedAt: "2026-04-18T13:00:00.000Z",
      decisions: [{ rank: 1, contestantName: "林晓", score: "98.30" }],
      awards: [],
    }],
  },
};

function mockQueries(options: {
  readonly site: unknown;
  readonly siteError?: unknown;
  readonly isPending?: boolean;
  readonly current?: unknown;
  readonly currentError?: unknown;
  readonly vote?: unknown;
  readonly voteError?: unknown;
}): void {
  useQueryMock.mockImplementation(({ queryKey }: { readonly queryKey: readonly unknown[] }) => {
    const base = { isFetching: false, dataUpdatedAt: Date.now(), refetch: vi.fn() };
    if (queryKey[0] === "public-current") {
      return {
        ...base,
        data: options.current,
        error: options.currentError ?? null,
        isPending: false,
        isError: options.currentError != null,
      };
    }
    if (queryKey[0] === "public-vote-entry") {
      return {
        ...base,
        data: options.vote,
        error: options.voteError ?? null,
        isPending: false,
        isError: options.voteError != null,
      };
    }
    return {
      ...base,
      data: options.site,
      error: options.siteError ?? null,
      isPending: options.isPending ?? false,
      isError: options.siteError != null,
    };
  });
}

const liveCurrent = {
  activity: { publicCode: "SPRING-1", title: "春日声场", status: "active" as const },
  current: { order: 2, slotLabel: "第一轮", title: "第一首", note: "", startsAt: null },
  next: [{ order: 3, slotLabel: "第一轮", title: "第二首", note: "", startsAt: null }],
};

describe("PublicEventPage", () => {
  beforeEach(() => {
    useParamsMock.mockReturnValue({ publicCode: "SPRING-1" });
    window.sessionStorage.clear();
  });

  it("renders the compact event home with the event content", () => {
    mockQueries({ site });
    render(<PublicEventPage />);
    expect(screen.getByRole("heading", { name: "春日声场" })).toBeInTheDocument();
    expect(document.querySelector(".event-hero--compact")).not.toBeNull();
    expect(screen.getByText("关于本次活动")).toBeInTheDocument();
    expect(screen.getByText("开场舞")).toBeInTheDocument();
    expect(screen.getByText("林晓")).toBeInTheDocument();
  });

  it("shows the not-found state", () => {
    mockQueries({ site: undefined, siteError: new PublicEventNotFound("SPRING-1") });
    render(<PublicEventPage />);
    expect(screen.getByText("活动不存在或尚未公开")).toBeInTheDocument();
  });

  it("renders the live current program and the vote action", () => {
    mockQueries({
      site,
      current: liveCurrent,
      vote: { sessionId: "vote-1", status: "open" },
    });
    render(<PublicEventPage />);
    expect(screen.getByText("第一首")).toBeInTheDocument();
    expect(screen.getByText("下一个：第二首")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /去投票/ })).toHaveAttribute("href", "/vote/vote-1");
    expect(screen.getByRole("link", { name: "现场" })).toHaveAttribute("href", "#live");
  });

  it("does not claim a next program without a current entry", () => {
    mockQueries({
      site,
      current: { ...liveCurrent, current: null, next: liveCurrent.next },
      vote: { sessionId: "vote-1", status: "open" },
    });
    render(<PublicEventPage />);
    expect(screen.getByText("暂无进行中的节目。")).toBeInTheDocument();
    expect(screen.queryByText(/下一个/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /去投票/ })).toBeInTheDocument();
  });

  it("closes the live state on a closed activity even with schedule data", () => {
    const closed = {
      ...site,
      activity: { ...site.activity, status: "closed" as const, registrationOpen: false },
    };
    mockQueries({ site: closed });
    render(<PublicEventPage />);
    expect(document.querySelector(".event-hero--compact")).toBeNull();
    expect(document.querySelector(".event-now")).toBeNull();
    expect(screen.queryByRole("link", { name: /去投票/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "查看赛果" }).length).toBeGreaterThan(0);
  });

  it("hides the current card on a 404 without retaining stale data", () => {
    mockQueries({ site, current: liveCurrent, currentError: new ApiError(404, "NOT_FOUND", "gone") });
    render(<PublicEventPage />);
    expect(document.querySelector(".event-now__name")).toBeNull();
    expect(screen.getByText("暂无进行中的节目。")).toBeInTheDocument();
  });

  it("keeps the last card and shows a retry on a network failure", () => {
    mockQueries({ site, current: liveCurrent, currentError: new Error("offline") });
    render(<PublicEventPage />);
    expect(screen.getByText("第一首")).toBeInTheDocument();
    expect(screen.getByText(/更新失败，展示的是最近一次数据/)).toBeInTheDocument();
  });

  it("hides the vote action when the vote entry cannot be read", () => {
    mockQueries({ site, current: liveCurrent, voteError: new Error("nope") });
    render(<PublicEventPage />);
    expect(screen.queryByRole("link", { name: /去投票/ })).not.toBeInTheDocument();
  });

  it("keeps the page readable when the activity refresh fails", () => {
    mockQueries({ site, siteError: new Error("offline") });
    render(<PublicEventPage />);
    expect(screen.getByText(/更新失败，展示的是最近一次数据/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "春日声场" })).toBeInTheDocument();
  });

  it("re-shows a dismissed announcement when the text changes", () => {
    mockQueries({ site });
    const { rerender } = render(<PublicEventPage />);
    fireEvent.click(screen.getByRole("button", { name: "关闭公告" }));
    expect(screen.queryByText("公告")).not.toBeInTheDocument();

    mockQueries({ site: { ...site, profile: { ...site.profile, announcement: "新公告" } } });
    rerender(<PublicEventPage />);
    expect(screen.getByText("新公告")).toBeInTheDocument();
  });
});
