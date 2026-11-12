import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AuroraScene } from "./AuroraScene.js";

describe("AuroraScene", () => {
  it("uses the static backdrop when reduced motion is requested", () => {
    render(<AuroraScene reducedMotion />);
    expect(screen.getByTestId("static-backdrop")).toBeInTheDocument();
  });

  it("uses the static backdrop on a narrow viewport", () => {
    const original = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === "(max-width: 767px)",
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as typeof window.matchMedia;
    try {
      render(<AuroraScene reducedMotion={false} />);
      expect(screen.getByTestId("static-backdrop")).toBeInTheDocument();
    } finally {
      window.matchMedia = original;
    }
  });
});
