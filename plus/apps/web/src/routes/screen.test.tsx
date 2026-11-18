import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ publicCode: "SPRING-1" }),
}));
vi.mock("qrcode", () => ({
  toDataURL: async () => "data:image/png;base64,AA",
}));
vi.mock("../api/publicEvent.js", () => ({
  fetchPublicEvent: vi.fn(async () => ({
    activity: { publicCode: "SPRING-1", title: "春季十佳", status: "active", registrationEnabled: true, registrationOpen: true },
    profile: {
      tagline: "唱响春天", description: "", venue: "大礼堂", startsAt: null, endsAt: null,
      organizer: "文艺部", contact: "", announcement: "请观众提前入场",
      announcements: [{ id: "a1", title: "入场提醒", body: "请提前 15 分钟入场", publishedAt: "2026-11-18T10:00:00Z" }],
      faq: [], links: [],
    },
    participants: null,
    schedule: null,
    program: null,
    results: {
      activityTitle: "春季十佳",
      results: [{
        stageKey: "final", publicTitle: "决赛结果", releasedAt: "2026-11-18T12:00:00Z",
        decisions: [{ rank: 1, contestantName: "林晓", score: "98.20" }], awards: [],
      }],
    },
  })),
}));
vi.mock("../api/tickets-public.js", () => ({
  fetchPublicCurrent: vi.fn(async () => ({
    activity: { publicCode: "SPRING-1", title: "春季十佳", status: "active" },
    current: { order: 3, slotLabel: "第 3 个", title: "夜空中最亮的星", note: "林晓", startsAt: null },
    next: [{ order: 4, slotLabel: "第 4 个", title: "海阔天空", note: "陈晨", startsAt: null }],
  })),
}));

import { ScreenPage } from "./screen.js";

describe("ScreenPage", () => {
  it("shows the current program, next entries and the released result", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ScreenPage />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("春季十佳")).toBeInTheDocument();
    expect(await screen.findByText("夜空中最亮的星")).toBeInTheDocument();
    expect(await screen.findByText("海阔天空")).toBeInTheDocument();
    expect((await screen.findAllByText("林晓")).length).toBeGreaterThan(0);
    expect(await screen.findByText("入场提醒")).toBeInTheDocument();
  });
});
