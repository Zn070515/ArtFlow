import {
  getParticipantIdentityLinkByActor,
  type Database,
} from "@artflow-plus/db";
import { canActFor, DomainError } from "@artflow-plus/domain";
import type { ActorContext } from "@artflow-plus/domain";
import type { Kysely } from "kysely";

export async function participantSubjectIds(
  db: Kysely<Database>,
  actor: ActorContext,
): Promise<readonly string[]> {
  const link = await getParticipantIdentityLinkByActor(db, actor.actorId);
  return link === null ? [actor.actorId] : [actor.actorId, link.legacyParticipantId];
}

export async function canActForParticipant(
  db: Kysely<Database>,
  actor: ActorContext,
  participantId: string,
  permission: string,
): Promise<boolean> {
  if (canActFor(actor, participantId, permission)) return true;
  return (await participantSubjectIds(db, actor)).includes(participantId);
}

export async function requireParticipantOwnership(
  db: Kysely<Database>,
  actor: ActorContext,
  participantId: string,
  permission: string,
  message: string,
): Promise<void> {
  if (!(await canActForParticipant(db, actor, participantId, permission))) {
    throw new DomainError("FORBIDDEN", message);
  }
}
