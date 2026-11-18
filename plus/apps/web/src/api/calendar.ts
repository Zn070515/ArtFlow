import type { PublicEventSite } from "./publicEvent.js";

function escapeIcs(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function icsDate(value: string): string | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** RFC 5545 single-event calendar; null when the start time is unusable. */
export function buildCalendarEvent(site: PublicEventSite, url: string): string | null {
  const start = site.profile.startsAt === null ? null : icsDate(site.profile.startsAt);
  if (start === null) return null;
  const end = site.profile.endsAt === null ? null : icsDate(site.profile.endsAt);
  const description = [site.profile.tagline, site.profile.description]
    .filter((value) => value.trim() !== "")
    .join("\n")
    .slice(0, 500);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//ArtFlow//Public Event//CN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${site.activity.publicCode}@artflow`,
    `DTSTAMP:${icsDate(new Date().toISOString())}`,
    `DTSTART:${start}`,
    ...(end === null ? [] : [`DTEND:${end}`]),
    `SUMMARY:${escapeIcs(site.activity.title)}`,
    ...(description === "" ? [] : [`DESCRIPTION:${escapeIcs(description)}`]),
    ...(site.profile.venue === "" ? [] : [`LOCATION:${escapeIcs(site.profile.venue)}`]),
    `URL:${escapeIcs(url)}`,
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ];
  return lines.join("\r\n");
}
