import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useQueryMock = vi.hoisted(() => vi.fn());
const useParamsMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({ useQuery: useQueryMock }));
vi.mock("@tanstack/react-router", () => ({ useParams: useParamsMock }));
vi.mock("../api/publicEvent.js", () => ({
  fetchPublicEvent: vi.fn(),
  PublicEventNotFound: class PublicEventNotFound extends Error {},
}));
vi.mock("../api/tickets-public.js", () => ({ fetchPublicCurrent: vi.fn() }));

import { PublicEventNotFound } from "../api/publicEvent.js";
import { EmbedPage } from "./embed.js";

const site = {
  activity: {
    publicCode: "SPRING-1",
    title: "春日声场",
    status: "active" as const,
    registrationEnabled: false,
    registrationOpen: false,
  },
  profile: {
    tagline: "春日",
    description: "",
    venue: "剧场",
    startsAt: "2026-04-18T11:00:00.000Z",
    endsAt: null,
    organizer: "",
    contact: "",
    announcement: "",
    announcements: [],
    faq: [],
    links: [],
  },
  participants: null,
  schedule: null,
  program: null,
  results: null,
};

function mockQueries(options: {
  readonly site: unknown;
  readonly siteError?: unknown;
  readonly current?: unknown;
}): void {
  useQueryMock.mockImplementation(({ queryKey }: { readonly queryKey: readonly unknown[] }) => {
    if (queryKey[0] === "embed-current") {
      return { data: options.current, error: null, isPending: false, isError: false };
    }
    return {
      data: options.site,
      error: options.siteError ?? null,
      isPending: false,
      isError: options.siteError != null,
    };
  });
}

const current = {
  activity: { publicCode: "SPRING-1", title: "春日声场", status: "active" as const },
  current: { order: 2, slotLabel: "《起风了》", title: "周然", note: "", startsAt: null },
  next: [{ order: 3, slotLabel: "《晴天》", title: "陈默", note: "", startsAt: null }],
};

describe("EmbedPage", () => {
  beforeEach(() => {
    useParamsMock.mockReturnValue({ publicCode: "SPRING-1" });
  });

  it("renders the compact now/next card and breaks out to the full page", () => {
    mockQueries({ site, current });
    render(<EmbedPage />);
    expect(screen.getByRole("heading", { name: "春日声场" })).toBeInTheDocument();
    expect(screen.getByText("周然")).toBeInTheDocument();
    expect(screen.getByText("下一个：陈默")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "查看完整活动 →" });
    expect(link).toHaveAttribute("href", "/e/SPRING-1");
    expect(link).toHaveAttribute("target", "_top");
  });

  it("renders the latest results for a closed event", () => {
    mockQueries({
      site: {
        ...site,
        activity: { ...site.activity, status: "closed" as const },
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
      },
    });
    render(<EmbedPage />);
    expect(screen.getByText(/林晓/)).toBeInTheDocument();
    expect(screen.getByText("正式赛果")).toBeInTheDocument();
  });

  it("shows a placeholder for a missing event", () => {
    mockQueries({ site: undefined, siteError: new PublicEventNotFound("SPRING-1") });
    render(<EmbedPage />);
    expect(screen.getByText("活动不存在或尚未公开。")).toBeInTheDocument();
  });
});
