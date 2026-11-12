import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Button } from "./Button.js";

describe("Button", () => {
  it("renders the requested variant and size", () => {
    render(<Button variant="primary" size="sm">保存</Button>);
    const button = screen.getByRole("button", { name: "保存" });
    expect(button).toHaveClass("ui-button", "ui-button--primary", "ui-button--sm");
  });

  it("defaults to secondary and medium", () => {
    render(<Button>取消</Button>);
    expect(screen.getByRole("button", { name: "取消" })).toHaveClass("ui-button--secondary", "ui-button--md");
  });

  it("disables the button and exposes busy state while loading", () => {
    render(<Button loading>保存</Button>);
    const button = screen.getByRole("button", { name: "保存" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
  });

  it("keeps a caller className", () => {
    render(<Button className="custom">打开</Button>);
    expect(screen.getByRole("button", { name: "打开" })).toHaveClass("ui-button", "custom");
  });
});
