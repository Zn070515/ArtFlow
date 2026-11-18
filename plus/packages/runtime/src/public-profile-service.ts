import type { Database } from "@artflow-plus/db";
import {
  getActivityForUpdate,
  upsertActivityPublicProfile,
  type StoredActivityPublicProfile,
} from "@artflow-plus/db";
import { DomainError, requirePermission } from "@artflow-plus/domain";
import type { Kysely } from "kysely";

import { executeCommand, type CommandOutcome } from "./command.js";
import { runtimeActor, type RuntimeDeps } from "./deps.js";
import { appendEngineEvent } from "./events.js";

export interface UpdatePublicProfileInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly expectedRevision: number;
  readonly tagline: string;
  readonly description: string;
  readonly venue: string;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly organizer: string;
  readonly contact: string;
  readonly announcement: string;
}

function requireText(value: string, field: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new DomainError("INVALID_INPUT", `${field} must be at most ${max} characters.`);
  }
  return trimmed;
}

function requireInstant(value: string | null, field: string): string | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new DomainError("INVALID_INPUT", `${field} must be an ISO timestamp.`);
  }
  return new Date(parsed).toISOString();
}

export async function updateActivityPublicProfile(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: UpdatePublicProfileInput,
): Promise<CommandOutcome<StoredActivityPublicProfile>> {
  const actor = runtimeActor(deps);
  return executeCommand(
    db,
    {
      commandId: input.commandId,
      activityId: input.activityId,
      capability: "engine",
      commandType: "activity.public_profile.update",
      actor,
      payload: {
        expectedRevision: input.expectedRevision,
        tagline: input.tagline,
        description: input.description,
        venue: input.venue,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        organizer: input.organizer,
        contact: input.contact,
        announcement: input.announcement,
      },
    },
    async (trx) => {
      requirePermission(actor, "studio.manage");
      // Lock order: activity first, then the profile row. This makes two
      // concurrent first saves serialize before the profile insert.
      const activity = await getActivityForUpdate(trx, input.activityId);
      if (activity === null) {
        throw new DomainError("NOT_FOUND", "The activity was not found.");
      }
      if (activity.status === "archived") {
        throw new DomainError("ACTIVITY_ARCHIVED", "An archived activity cannot be modified.");
      }
      const startsAt = requireInstant(input.startsAt, "startsAt");
      const endsAt = requireInstant(input.endsAt, "endsAt");
      if (startsAt !== null && endsAt !== null && endsAt < startsAt) {
        throw new DomainError("INVALID_INPUT", "endsAt must not be before startsAt.");
      }
      const saved = await upsertActivityPublicProfile(trx, {
        activityId: activity.id,
        tagline: requireText(input.tagline, "tagline", 160),
        description: requireText(input.description, "description", 4000),
        venue: requireText(input.venue, "venue", 200),
        startsAt,
        endsAt,
        organizer: requireText(input.organizer, "organizer", 200),
        contact: requireText(input.contact, "contact", 200),
        announcement: requireText(input.announcement, "announcement", 2000),
        updatedBy: actor.actorId,
        updatedAt: deps.now(),
      }, input.expectedRevision);
      await appendEngineEvent(trx, deps, {
        type: "ActivityPublicProfileUpdated",
        activityId: activity.id,
        aggregateType: "activity",
        aggregateId: activity.id,
        revision: saved.revision,
        payload: { activityId: activity.id, revision: saved.revision },
      });
      return { body: saved };
    },
  );
}
