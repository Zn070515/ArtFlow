import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ExportCard } from "./ExportCard.js";

describe("ExportCard", () => {
  it("offers CSV, Word, and Excel for every permitted dataset", () => {
    render(
      <ExportCard
        activityId="act_1"
        permissions={["registration.review", "competition.manage", "result.manage"]}
        documentFormats={["csv", "docx", "xlsx"]}
      />,
    );
    for (const kind of ["registrations", "materials", "scores", "votes"]) {
      for (const format of ["csv", "docx", "xlsx"]) {
        expect(screen.getByTestId(`export-${kind}-${format}`)).toHaveAttribute(
          "href",
          `/api/activities/act_1/exports/${kind}?format=${format}`,
        );
      }
    }
  });

  it("hides datasets the actor cannot export", () => {
    render(<ExportCard activityId="act_1" permissions={["registration.review"]} />);
    expect(screen.getByTestId("export-registrations-csv")).toBeInTheDocument();
    expect(screen.getByTestId("export-materials-csv")).toBeInTheDocument();
    expect(screen.queryByTestId("export-scores-csv")).toBeNull();
    expect(screen.queryByTestId("export-votes-csv")).toBeNull();
  });

  it("offers only CSV when the deployment has no document renderer", () => {
    render(
      <ExportCard
        activityId="act_1"
        permissions={["registration.review"]}
        documentFormats={["csv"]}
      />,
    );
    expect(screen.getByTestId("export-registrations-csv")).toBeInTheDocument();
    expect(screen.queryByTestId("export-registrations-docx")).toBeNull();
    expect(screen.queryByTestId("export-registrations-xlsx")).toBeNull();
  });

  it("renders nothing without an export permission", () => {
    const { container } = render(<ExportCard activityId="act_1" permissions={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
