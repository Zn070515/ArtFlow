import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  EventAnnouncements,
  EventFaq,
  EventLinks,
  EventParticipants,
} from "./EventContentBlocks.js";

describe("EventContentBlocks", () => {
  it("orders announcements newest first", () => {
    render(
      <EventAnnouncements
        items={[
          { id: "old", title: "旧公告", body: "旧内容", publishedAt: "2026-04-01T10:00:00.000Z" },
          { id: "new", title: "新公告", body: "新内容", publishedAt: "2026-04-02T10:00:00.000Z" },
        ]}
      />,
    );
    const titles = screen.getAllByRole("heading", { level: 3 }).map((element) => element.textContent);
    expect(titles).toEqual(["新公告", "旧公告"]);
    expect(screen.getByText("新内容")).toBeInTheDocument();
  });

  it("renders FAQ as native details and links as safe external anchors", () => {
    render(
      <>
        <EventFaq items={[{ question: "怎么入场？", answer: "出示电子票。" }]} />
        <EventLinks items={[{ label: "官网", url: "https://example.com/info" }]} />
      </>,
    );
    expect(screen.getByText("怎么入场？").closest("summary")).not.toBeNull();
    const link = screen.getByRole("link", { name: "官网" });
    expect(link).toHaveAttribute("href", "https://example.com/info");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer noopener");
  });

  it("renders the participant directory only when present", () => {
    const { container } = render(
      <EventParticipants items={[{ name: "林晓", program: "《后来》" }]} />,
    );
    expect(screen.getByText("林晓")).toBeInTheDocument();
    expect(screen.getByText("《后来》")).toBeInTheDocument();

    const empty = render(<EventParticipants items={null} />);
    expect(empty.container).toBeEmptyDOMElement();
    expect(container).not.toBeEmptyDOMElement();
  });
});
