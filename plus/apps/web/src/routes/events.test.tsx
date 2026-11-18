import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useQueryMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({ useQuery: useQueryMock }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, params, children }: {
    readonly to: string;
    readonly params?: Readonly<Record<string, string>>;
    readonly children: ReactNode;
  }) => <a href={to.replace(/\$publicCode/g, params?.publicCode ?? "")}>{children}</a>,
}));

import { EventsPage } from "./events.js";

const events = [
  {
    publicCode: "SPRING-1",
    title: "春日声场",
    status: "active" as const,
    tagline: "春日",
    venue: "剧场",
    startsAt: "2026-04-18T11:00:00.000Z",
    endsAt: null,
    organizer: "学生会",
  },
  {
    publicCode: "SUMMER-1",
    title: "夏日舞台",
    status: "closed" as const,
    tagline: "夏日",
    venue: "礼堂",
    startsAt: null,
    endsAt: null,
    organizer: "文艺部",
  },
];

describe("EventsPage", () => {
  beforeEach(() => {
    useQueryMock.mockReturnValue({
      data: events,
      error: null,
      isPending: false,
      refetch: vi.fn(),
    });
  });

  it("lists public events and filters them by search", () => {
    render(<EventsPage />);
    expect(screen.getByText("春日声场")).toBeInTheDocument();
    expect(screen.getByText("夏日舞台")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("搜索活动"), { target: { value: "夏日" } });
    expect(screen.getByText("夏日舞台")).toBeInTheDocument();
    expect(screen.queryByText("春日声场")).not.toBeInTheDocument();
  });

  it("shows an empty state when there is nothing to list", () => {
    useQueryMock.mockReturnValue({
      data: [],
      error: null,
      isPending: false,
      refetch: vi.fn(),
    });
    render(<EventsPage />);
    expect(screen.getByText("暂时没有公开活动。")).toBeInTheDocument();
  });
});
