import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ConsolePagination } from "./ConsolePagination.js";

describe("ConsolePagination", () => {
  it("exposes page status and navigation controls", () => {
    const onPageChange = vi.fn();
    render(<ConsolePagination page={2} totalPages={4} onPageChange={onPageChange} />);

    expect(screen.getByRole("navigation", { name: "表格分页" })).toHaveTextContent("第 2 / 4 页");
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));

    expect(onPageChange).toHaveBeenCalledWith(3);
    expect(screen.getByRole("button", { name: "上一页" })).toBeEnabled();
  });

  it("does not render controls for a single page", () => {
    render(<ConsolePagination page={1} totalPages={1} onPageChange={vi.fn()} />);

    expect(screen.queryByRole("navigation", { name: "表格分页" })).not.toBeInTheDocument();
  });
});
