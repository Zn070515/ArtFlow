import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ExportCard } from "./ExportCard.js";

describe("ExportCard", () => {
  it("shows only the sheets the actor is allowed to download", () => {
    render(<ExportCard activityId="activity-1" permissions={["registration.review"]} />);
    expect(screen.getByRole("link", { name: "导出报名表" })).toHaveAttribute(
      "href",
      "/api/activities/activity-1/exports/registrations",
    );
    expect(screen.getByRole("link", { name: "导出材料清单" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "导出评分表" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "导出观众票" })).not.toBeInTheDocument();
  });
});
