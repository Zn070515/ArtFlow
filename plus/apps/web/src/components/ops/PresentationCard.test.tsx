import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PresentationCard } from "./PresentationCard.js";

describe("PresentationCard", () => {
  it("links to the public presentation surfaces", () => {
    render(<PresentationCard publicCode="SPRING-1" />);
    expect(screen.getByRole("link", { name: "现场大屏" })).toHaveAttribute("href", "/screen/SPRING-1");
    expect(screen.getByRole("link", { name: "主持手卡" })).toHaveAttribute("href", "/host-card/SPRING-1");
    expect(screen.getByRole("link", { name: "二维码打印包" })).toHaveAttribute("href", "/print/SPRING-1");
  });
});
