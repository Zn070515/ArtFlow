import { describe, expect, it } from "vitest";

import { buildCalendarEvent } from "./calendar.js";
import type { PublicEventSite } from "./publicEvent.js";

const site: PublicEventSite = {
  activity: {
    publicCode: "SPRING-1",
    title: "春日声场",
    status: "active",
    registrationEnabled: false,
    registrationOpen: false,
  },
  profile: {
    tagline: "春日",
    description: "介绍\n第二行",
    venue: "剧场, 东门",
    startsAt: "2026-04-18T11:00:00.000Z",
    endsAt: "2026-04-18T13:30:00.000Z",
    organizer: "学生会",
    contact: "",
    announcement: "",
    announcements: [],
    faq: [],
    links: [],
  },
  participants: null,
  schedule: null,
  program: null,
  results: null,
};

describe("buildCalendarEvent", () => {
  it("builds a single-event calendar with escaped text", () => {
    const calendar = buildCalendarEvent(site, "https://artflow.example/e/SPRING-1");
    expect(calendar).toContain("BEGIN:VCALENDAR");
    expect(calendar).toContain("UID:SPRING-1@artflow");
    expect(calendar).toContain("DTSTART:20260418T110000Z");
    expect(calendar).toContain("DTEND:20260418T133000Z");
    expect(calendar).toContain("SUMMARY:春日声场");
    expect(calendar).toContain("LOCATION:剧场\\, 东门");
    expect(calendar).toContain("DESCRIPTION:春日\\n介绍\\n第二行");
    expect(calendar).toContain("URL:https://artflow.example/e/SPRING-1");
  });

  it("returns null without a usable start time", () => {
    expect(buildCalendarEvent({
      ...site,
      profile: { ...site.profile, startsAt: null },
    }, "https://artflow.example/e/SPRING-1")).toBeNull();
    expect(buildCalendarEvent({
      ...site,
      profile: { ...site.profile, startsAt: "not-a-date" },
    }, "https://artflow.example/e/SPRING-1")).toBeNull();
  });
});
