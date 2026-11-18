import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ publicCode: "SPRING-1" }),
}));
vi.mock("../api/publicEvent.js", () => ({
  fetchPublicEvent: vi.fn(async () => ({
    activity: { publicCode: "SPRING-1", title: "春季十佳", status: "active", registrationEnabled: true, registrationOpen: true },
    profile: {
      tagline: "", description: "", venue: "大礼堂", startsAt: "2026-11-18T19:00:00Z", endsAt: null,
      organizer: "文艺部", contact: "", announcement: "请提前入场", announcements: [], faq: [], links: [],
    },
    participants: null,
    schedule: { entries: [{ order: 1, slotLabel: "第 1 个", title: "开场", note: "", startsAt: null }] },
    program: null,
    results: {
      activityTitle: "春季十佳",
      results: [{
        stageKey: "final", publicTitle: "决赛结果", releasedAt: "2026-11-18T12:00:00Z",
        decisions: [{ rank: 1, contestantName: "林晓", score: "98.20" }],
        awards: [{ award: "冠军", contestantName: "林晓" }],
      }],
    },
  })),
}));
vi.mock("../api/tickets-public.js", () => ({
  fetchPublicCurrent: vi.fn(async () => ({
    activity: { publicCode: "SPRING-1", title: "春季十佳", status: "active" },
    current: { order: 3, slotLabel: "第 3 个", title: "夜空中最亮的星", note: "林晓", startsAt: null },
    next: [],
  })),
}));

import { HostCardPage } from "./hostCard.js";

describe("HostCardPage", () => {
  it("prints the current program, schedule and released result", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <HostCardPage />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("春季十佳")).toBeInTheDocument();
    expect(await screen.findByText("夜空中最亮的星")).toBeInTheDocument();
    expect(await screen.findByText("开场")).toBeInTheDocument();
    expect(await screen.findByText("决赛结果")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打印手卡" })).toBeInTheDocument();
  });
});
