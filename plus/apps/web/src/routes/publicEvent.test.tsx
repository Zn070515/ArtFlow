import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useQueryMock = vi.hoisted(() => vi.fn());
const useParamsMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({ useQuery: useQueryMock }));
vi.mock("@tanstack/react-router", () => ({
  useParams: useParamsMock,
  Link: ({ children }: { readonly children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../api/publicEvent.js", () => ({
  fetchPublicEvent: vi.fn(),
  PublicEventNotFound: class PublicEventNotFound extends Error {},
}));

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
  readonly error?: unknown;
  readonly isPending?: boolean;
  readonly current?: unknown;
  readonly vote?: unknown;
}): void {
  useQueryMock.mockImplementation(({ queryKey }: { readonly queryKey: readonly unknown[] }) => {
    if (queryKey[0] === "public-current") {
      return { data: options.current, error: null, isPending: false };
    }
    if (queryKey[0] === "public-vote-entry") {
      return { data: options.vote, error: null, isPending: false };
    }
    return {
      data: options.site,
      error: options.error ?? null,
      isPending: options.isPending ?? false,
    };
  });
}

describe("PublicEventPage", () => {
  beforeEach(() => {
    useParamsMock.mockReturnValue({ publicCode: "SPRING-1" });
  });

  it("renders the event home", () => {
    mockQueries({ site });
    render(<PublicEventPage />);
    expect(screen.getByRole("heading", { name: "春日声场" })).toBeInTheDocument();
    expect(screen.getByText("关于本次活动")).toBeInTheDocument();
    expect(screen.getByText("开场舞")).toBeInTheDocument();
    expect(screen.getByText("林晓")).toBeInTheDocument();
  });

  it("shows the not-found state", () => {
    mockQueries({ site: undefined, error: new PublicEventNotFound("SPRING-1") });
    render(<PublicEventPage />);
    expect(screen.getByText("活动不存在或尚未公开")).toBeInTheDocument();
  });

  it("renders the live current program and vote entry", () => {
    mockQueries({
      site,
      current: {
        activity: { publicCode: "SPRING-1", title: "春日声场", status: "active" },
        current: { order: 2, slotLabel: "第一轮", title: "第一首", note: "", startsAt: null },
        next: [{ order: 3, slotLabel: "第一轮", title: "第二首", note: "", startsAt: null }],
      },
      vote: { sessionId: "vote-1", status: "open" },
    });
    render(<PublicEventPage />);
    expect(screen.getByText(/当前：第一首/)).toBeInTheDocument();
    expect(screen.getByText(/接下来：第二首/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /去投票/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "现场" })).toBeInTheDocument();
  });
});
