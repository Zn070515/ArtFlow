import type { Database } from "@artflow-plus/db";
import {
  getActivityForUpdate,
  upsertActivityPublicProfile,
  type PublicAnnouncement,
  type PublicFaqItem,
  type PublicLink,
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
  readonly announcements: readonly PublicAnnouncement[];
  readonly faq: readonly PublicFaqItem[];
  readonly links: readonly PublicLink[];
  readonly participantsVisible: boolean;
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

function requireRequired(value: string, field: string, max: number): string {
  const trimmed = requireText(value, field, max);
  if (trimmed === "") {
    throw new DomainError("INVALID_INPUT", `${field} is required.`);
  }
  return trimmed;
}

function requireAnnouncements(
  items: readonly PublicAnnouncement[],
): readonly PublicAnnouncement[] {
  if (items.length > 20) {
    throw new DomainError("INVALID_INPUT", "announcements must have at most 20 items.");
  }
  const seen = new Set<string>();
  const result: PublicAnnouncement[] = [];
  for (const [index, item] of items.entries()) {
    const title = requireText(item.title, `announcements[${index}].title`, 120);
    const body = requireText(item.body, `announcements[${index}].body`, 1000);
    if (title === "" && body === "") continue;
    const id = requireRequired(item.id, `announcements[${index}].id`, 100);
    if (seen.has(id)) {
      throw new DomainError("INVALID_INPUT", "Announcement ids must be unique.");
    }
    seen.add(id);
    const publishedAt = requireInstant(item.publishedAt, `announcements[${index}].publishedAt`);
    if (publishedAt === null) {
      throw new DomainError("INVALID_INPUT", `announcements[${index}].publishedAt is required.`);
    }
    result.push({ id, title, body, publishedAt });
  }
  return result;
}

function requireFaq(items: readonly PublicFaqItem[]): readonly PublicFaqItem[] {
  if (items.length > 20) {
    throw new DomainError("INVALID_INPUT", "faq must have at most 20 items.");
  }
  const result: PublicFaqItem[] = [];
  for (const [index, item] of items.entries()) {
    const question = requireText(item.question, `faq[${index}].question`, 200);
    const answer = requireText(item.answer, `faq[${index}].answer`, 1000);
    if (question === "" && answer === "") continue;
    if (question === "" || answer === "") {
      throw new DomainError("INVALID_INPUT", `faq[${index}] needs both question and answer.`);
    }
    result.push({ question, answer });
  }
  return result;
}

function requireLinks(items: readonly PublicLink[]): readonly PublicLink[] {
  if (items.length > 10) {
    throw new DomainError("INVALID_INPUT", "links must have at most 10 items.");
  }
  const result: PublicLink[] = [];
  for (const [index, item] of items.entries()) {
    const label = requireText(item.label, `links[${index}].label`, 80);
    const url = requireText(item.url, `links[${index}].url`, 500);
    if (label === "" && url === "") continue;
    if (label === "" || url === "") {
      throw new DomainError("INVALID_INPUT", `links[${index}] needs both label and url.`);
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new DomainError("INVALID_INPUT", `links[${index}].url must be an absolute URL.`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new DomainError("INVALID_INPUT", `links[${index}].url must use http or https.`);
    }
    result.push({ label, url });
  }
  return result;
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
        announcements: input.announcements,
        faq: input.faq,
        links: input.links,
        participantsVisible: input.participantsVisible,
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
        announcements: requireAnnouncements(input.announcements),
        faq: requireFaq(input.faq),
        links: requireLinks(input.links),
        participantsVisible: input.participantsVisible,
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
