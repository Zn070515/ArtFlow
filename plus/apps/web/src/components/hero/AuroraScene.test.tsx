import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AuroraScene } from "./AuroraScene.js";

describe("AuroraScene", () => {
  it("uses the static backdrop when reduced motion is requested", () => {
    render(<AuroraScene reducedMotion />);
    expect(screen.getByTestId("static-backdrop")).toBeInTheDocument();
  });
});
