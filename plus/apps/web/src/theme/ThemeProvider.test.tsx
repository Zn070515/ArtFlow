import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { ThemeProvider, useTheme } from "./ThemeProvider.js";

function Probe() {
  const { theme, setTheme } = useTheme();
  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <button type="button" onClick={() => setTheme(theme === "paper" ? "graphite" : "paper")}>
        toggle
      </button>
    </div>
  );
}

describe("ThemeProvider", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("falls back to the provided default", () => {
    render(
      <ThemeProvider defaultTheme="graphite">
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId("theme")).toHaveTextContent("graphite");
  });

  it("persists a user choice", () => {
    render(
      <ThemeProvider defaultTheme="graphite">
        <Probe />
      </ThemeProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "toggle" }));
    expect(screen.getByTestId("theme")).toHaveTextContent("paper");
    expect(localStorage.getItem("artflow-theme")).toBe("paper");
  });

  it("ignores an invalid stored value", () => {
    localStorage.setItem("artflow-theme", "neon");
    render(
      <ThemeProvider defaultTheme="paper">
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId("theme")).toHaveTextContent("paper");
  });
});
