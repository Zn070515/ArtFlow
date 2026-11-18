import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { AnnouncementBanner } from "./AnnouncementBanner.js";

describe("AnnouncementBanner", () => {
  beforeEach(() => window.sessionStorage.clear());

  it("dismisses until the announcement text changes", () => {
    const { rerender } = render(
      <AnnouncementBanner publicCode="SPRING-1" announcement="第 8 位选手请到后台候场" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "关闭公告" }));
    expect(screen.queryByText("第 8 位选手请到后台候场")).not.toBeInTheDocument();

    rerender(<AnnouncementBanner publicCode="SPRING-1" announcement="第 8 位选手请到后台候场" />);
    expect(screen.queryByText("第 8 位选手请到后台候场")).not.toBeInTheDocument();

    rerender(<AnnouncementBanner publicCode="SPRING-1" announcement="决赛结果将在 20:30 公布" />);
    expect(screen.getByText("决赛结果将在 20:30 公布")).toBeInTheDocument();
  });

  it("renders nothing for an empty announcement", () => {
    const { container } = render(<AnnouncementBanner publicCode="SPRING-1" announcement="  " />);
    expect(container).toBeEmptyDOMElement();
  });
});
