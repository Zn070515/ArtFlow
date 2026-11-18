import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { EmbedSnippet } from "./EmbedSnippet.js";

describe("EmbedSnippet", () => {
  it("renders and copies the iframe snippet", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    render(<EmbedSnippet publicCode="SPRING-1" />);
    expect(screen.getByText(/\/embed\/SPRING-1/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "复制嵌入代码" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining("/embed/SPRING-1"),
    ));
    expect(await screen.findByText("已复制")).toBeInTheDocument();
  });
});
