import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Badge } from "./Badge.js";
import { Card, CardHeader } from "./Card.js";

describe("Badge and Card", () => {
  it("renders a badge with its tone and text", () => {
    render(<Badge tone="success">进行中</Badge>);
    const badge = screen.getByText("进行中");
    expect(badge).toHaveClass("ui-badge", "ui-badge--success");
  });

  it("renders a card header with an action", () => {
    render(
      <Card>
        <CardHeader title="活动摘要" description="3 个活动" actions={<button type="button">刷新</button>} />
        <p>内容</p>
      </Card>,
    );
    expect(screen.getByRole("heading", { name: "活动摘要" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "刷新" })).toBeInTheDocument();
    expect(screen.getByText("内容").closest(".ui-card")).not.toBeNull();
  });
});
