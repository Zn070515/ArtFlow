import type { Database, StoredTicket } from "@artflow-plus/db";
import { getActivityPublicProfile, getActivitySummary } from "@artflow-plus/db";
import { DomainError } from "@artflow-plus/domain";
import type { Kysely } from "kysely";

import type { RuntimeDeps } from "./deps.js";
import { lookupTicketByCredential } from "./ticket-service.js";

export interface PublicTicketLookup {
  readonly ticket: {
    readonly publicCode: string;
    readonly state: StoredTicket["state"];
    readonly credentialVersion: number;
    readonly issuedAt: string;
    readonly redeemedAt?: string;
    readonly revokedAt?: string;
  };
  readonly activity: {
    readonly publicCode: string;
    readonly title: string;
    readonly status: "active" | "closed";
    readonly startsAt: string | null;
    readonly endsAt: string | null;
    readonly venue: string;
    readonly organizer: string;
  };
  readonly links: { readonly event: string; readonly results: string };
}

export async function getPublicTicketLookup(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  credential: string,
): Promise<PublicTicketLookup> {
  const ticket = await lookupTicketByCredential(db, deps, credential);
  const activity = await getActivitySummary(db, ticket.activityId);
  if (activity === null || (activity.status !== "active" && activity.status !== "closed")) {
    throw new DomainError("TICKET_ACTIVITY_NOT_PUBLIC", "The activity is not public.");
  }
  const profile = await getActivityPublicProfile(db, activity.id);
  return {
    ticket: {
      publicCode: ticket.publicCode,
      state: ticket.state,
      credentialVersion: ticket.credentialVersion,
      issuedAt: ticket.issuedAt,
      ...(ticket.redeemedAt === undefined ? {} : { redeemedAt: ticket.redeemedAt }),
      ...(ticket.revokedAt === undefined ? {} : { revokedAt: ticket.revokedAt }),
    },
    activity: {
      publicCode: activity.publicCode,
      title: activity.title,
      status: activity.status,
      startsAt: profile.startsAt,
      endsAt: profile.endsAt,
      venue: profile.venue,
      organizer: profile.organizer,
    },
    links: {
      event: `/e/${encodeURIComponent(activity.publicCode)}`,
      results: `/results/${encodeURIComponent(activity.publicCode)}`,
    },
  };
}
