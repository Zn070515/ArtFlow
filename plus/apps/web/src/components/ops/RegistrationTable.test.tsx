import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...props }: { readonly children: ReactNode; readonly to: string; readonly [key: string]: unknown }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

import { RegistrationTable } from "./RegistrationTable.js";

describe("RegistrationTable", () => {
  it("filters registrations by participant and status", () => {
    render(
      <RegistrationTable
        activityId="activity-1"
        registrations={[
          { id: "registration-1", participantId: "alice", status: "submitted", revision: 2, reviewNote: null },
          { id: "registration-2", participantId: "bob", status: "approved", revision: 1, reviewNote: "已确认" },
        ]}
      />,
    );

    fireEvent.change(screen.getByRole("searchbox", { name: "搜索报名" }), {
      target: { value: "alice" },
    });

    expect(screen.getByRole("link", { name: "alice" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "bob" })).not.toBeInTheDocument();
  });
});
