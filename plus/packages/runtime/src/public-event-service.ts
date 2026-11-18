import type {
  Database,
  PublicAnnouncement,
  PublicFaqItem,
  PublicLink,
} from "@artflow-plus/db";
import {
  getActivityPublicProfile,
  selectPublicResults,
} from "@artflow-plus/db";
import type { Kysely } from "kysely";

import {
  getPublicActivity,
  getPublicParticipants,
  getPublicProgram,
  type PublicParticipant,
} from "./registration-read-service.js";
import { getPublicSchedule } from "./schedule-service.js";

export interface PublicEventSite {
  readonly activity: {
    readonly publicCode: string;
    readonly title: string;
    readonly status: "active" | "closed";
    readonly registrationEnabled: boolean;
    readonly registrationOpen: boolean;
  };
  readonly profile: {
    readonly tagline: string;
    readonly description: string;
    readonly venue: string;
    readonly startsAt: string | null;
    readonly endsAt: string | null;
    readonly organizer: string;
    readonly contact: string;
    readonly announcement: string;
    readonly announcements: readonly PublicAnnouncement[];
    readonly faq: readonly PublicFaqItem[];
    readonly links: readonly PublicLink[];
  };
  readonly participants: readonly PublicParticipant[] | null;
  readonly schedule: {
    readonly entries: readonly {
      readonly order: number;
      readonly slotLabel: string;
      readonly title: string;
      readonly note: string;
      readonly startsAt: string | null;
    }[];
  } | null;
  readonly program: {
    readonly entries: readonly {
      readonly order: number;
      readonly name: string;
      readonly song: string;
      readonly note: string;
      readonly startsAt: string | null;
    }[];
  } | null;
  readonly results: {
    readonly activityTitle: string;
    readonly results: readonly {
      readonly stageKey: string;
      readonly publicTitle: string;
      readonly releasedAt: string;
      readonly decisions: readonly {
        readonly rank: number;
        readonly contestantName: string;
        readonly score: string;
        readonly unit?: "score" | "percent";
      }[];
      readonly awards: readonly {
        readonly award: string;
        readonly contestantName: string;
      }[];
    }[];
  } | null;
}

export async function getPublicEventSite(
  db: Kysely<Database>,
  publicCode: string,
): Promise<PublicEventSite | null> {
  const activity = await getPublicActivity(db, publicCode);
  if (activity === null) return null;
  const status = activity.status === "active" || activity.status === "closed"
    ? activity.status
    : null;
  if (status === null) return null;
  const [profile, schedule, program, results] = await Promise.all([
    getActivityPublicProfile(db, activity.id),
    getPublicSchedule(db, publicCode),
    getPublicProgram(db, publicCode),
    selectPublicResults(db, publicCode),
  ]);
  const participants = profile.participantsVisible
    ? await getPublicParticipants(db, publicCode)
    : null;
  return {
    activity: {
      publicCode: activity.publicCode,
      title: activity.title,
      status,
      registrationEnabled: activity.registrationEnabled,
      registrationOpen: activity.registrationOpen,
    },
    profile: {
      tagline: profile.tagline,
      description: profile.description,
      venue: profile.venue,
      startsAt: profile.startsAt,
      endsAt: profile.endsAt,
      organizer: profile.organizer,
      contact: profile.contact,
      announcement: profile.announcement,
      announcements: profile.announcements,
      faq: profile.faq,
      links: profile.links,
    },
    participants,
    schedule: schedule === null
      ? null
      : {
          entries: schedule.entries.map((entry) => ({
            order: entry.order,
            slotLabel: entry.slotLabel,
            title: entry.title,
            note: entry.note,
            startsAt: entry.startsAt ?? null,
          })),
        },
    program: program === null
      ? null
      : {
          entries: program.entries.map((entry) => ({
            order: entry.order,
            name: entry.name,
            song: entry.song,
            note: entry.note,
            startsAt: entry.startsAt ?? null,
          })),
        },
    results: results === null || results.results.length === 0
      ? null
      : {
          activityTitle: results.activityTitle,
          results: results.results.map((result) => ({
            stageKey: result.stageKey,
            publicTitle: result.publicTitle,
            releasedAt: result.releasedAt,
            decisions: result.decisions.map((decision) => ({
              rank: decision.rank,
              contestantName: decision.contestantName,
              score: decision.score,
              ...(decision.unit === undefined ? {} : { unit: decision.unit }),
            })),
            awards: result.awards.map((award) => ({
              award: award.award,
              contestantName: award.contestantName,
            })),
          })),
        },
  };
}
