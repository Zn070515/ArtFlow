import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { EmptyState } from "./EmptyState.js";
import { ErrorState } from "./ErrorState.js";

describe("EmptyState and ErrorState", () => {
  it("renders an empty state with an action", () => {
    render(<EmptyState title="还没有活动" description="创建第一个活动后从这里开始。" action={<button type="button">新建活动</button>} />);
    expect(screen.getByRole("heading", { name: "还没有活动" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新建活动" })).toBeInTheDocument();
  });

  it("renders an error state and invokes retry", () => {
    const onRetry = vi.fn();
    render(<ErrorState description="活动列表暂时无法加载。" onRetry={onRetry} />);
    expect(screen.getByRole("alert")).toHaveTextContent("活动列表暂时无法加载。");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
