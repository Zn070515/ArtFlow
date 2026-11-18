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
      tagline: "", description: "", venue: "", startsAt: null, endsAt: null, organizer: "", contact: "",
      announcement: "", announcements: [], faq: [], links: [],
    },
    participants: null, schedule: null, program: null, results: null,
  })),
}));

import { PrintPackPage } from "./print.js";

describe("PrintPackPage", () => {
  it("renders public QR destinations and a print action", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <PrintPackPage />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("活动主页")).toBeInTheDocument();
    expect(screen.getByText("报名入口")).toBeInTheDocument();
    expect(screen.getByText("现场大屏")).toBeInTheDocument();
    expect(screen.getByText("主持手卡")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打印这一页" })).toBeInTheDocument();
  });
});
