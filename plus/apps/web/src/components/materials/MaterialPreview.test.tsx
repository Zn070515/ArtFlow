import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MaterialPreview } from "./MaterialPreview.js";

const src = "/api/activities/a/materials/m/content";

describe("MaterialPreview", () => {
  it("renders images inline and links to the full file", () => {
    render(<MaterialPreview src={src} contentType="image/jpeg" name="海报.jpg" />);
    expect(screen.getByRole("img", { name: "海报.jpg" })).toHaveAttribute("src", src);
  });

  it("renders audio and video with native controls", () => {
    const { container, rerender } = render(
      <MaterialPreview src={src} contentType="audio/mpeg" name="伴奏.mp3" />,
    );
    expect(container.querySelector("audio")).toHaveAttribute("src", src);
    rerender(<MaterialPreview src={src} contentType="video/mp4" name="节目.mp4" />);
    expect(container.querySelector("video")).toHaveAttribute("src", src);
  });

  it("falls back to an authenticated download link for documents", () => {
    render(<MaterialPreview src={src} contentType="application/pdf" name="剧本.pdf" />);
    expect(screen.getByRole("link", { name: /剧本\.pdf/ })).toHaveAttribute("href", src);
  });
});
