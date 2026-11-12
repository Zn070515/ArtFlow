import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TokensPage } from "./tokens.js";

describe("TokensPage", () => {
  it("shows the scales, the three themes and the primitives", () => {
    render(<TokensPage />);
    expect(screen.getByRole("heading", { name: "设计 token" })).toBeInTheDocument();
    expect(screen.getByText("paper")).toBeInTheDocument();
    expect(screen.getByText("graphite")).toBeInTheDocument();
    expect(screen.getByText("afterglow")).toBeInTheDocument();
    expect(screen.getAllByRole("button").length).toBeGreaterThan(0);
    expect(screen.getByText("16px")).toBeInTheDocument();
  });
});
