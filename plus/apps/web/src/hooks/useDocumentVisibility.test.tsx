import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useDocumentVisibility } from "./useDocumentVisibility.js";

function Probe() {
  return <span>{useDocumentVisibility() ? "hidden" : "visible"}</span>;
}

afterEach(() => {
  delete (document as { visibilityState?: string }).visibilityState;
});

describe("useDocumentVisibility", () => {
  it("tracks visibilitychange", () => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    render(<Probe />);
    expect(screen.getByText("visible")).toBeInTheDocument();

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(screen.getByText("hidden")).toBeInTheDocument();
  });
});
