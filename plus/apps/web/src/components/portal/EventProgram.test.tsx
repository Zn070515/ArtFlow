import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { PublicEventSite } from "../../api/publicEvent.js";
import { EventProgram } from "./EventProgram.js";

const site: PublicEventSite = {
  activity: {
    publicCode: "SPRING-1",
    title: "春日声场",
    status: "active",
    registrationEnabled: false,
    registrationOpen: false,
  },
  profile: {
    tagline: "",
    description: "",
    venue: "",
    startsAt: null,
    endsAt: null,
    organizer: "",
    contact: "",
    announcement: "",
  },
  schedule: {
    entries: [
      { order: 1, slotLabel: "开场", title: "开场舞", note: "", startsAt: null },
      { order: 2, slotLabel: "第一首", title: "林晓", note: "", startsAt: null },
    ],
  },
  program: null,
  results: null,
};

describe("EventProgram", () => {
  it("marks the current entry and offers a return anchor", () => {
    const { container } = render(<EventProgram site={site} currentOrder={2} />);
    const current = container.querySelector('[aria-current="true"]');
    expect(current).not.toBeNull();
    expect(current).toHaveTextContent("林晓");
    expect(current).toHaveTextContent("现在");
    expect(screen.getByRole("button", { name: "回到现在" })).toBeInTheDocument();
  });

  it("does not guess when the current entry is missing", () => {
    const { container } = render(<EventProgram site={site} currentOrder={null} />);
    expect(container.querySelector('[aria-current="true"]')).toBeNull();
    expect(screen.queryByRole("button", { name: "回到现在" })).not.toBeInTheDocument();
  });
});
