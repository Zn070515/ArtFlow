import type { Database, StoredActivityFeedback } from "@artflow-plus/db";
import {
  getActivityByPublicCode,
  getActivityForUpdate,
  insertActivityFeedback,
  listActivityFeedback,
  summarizeActivityFeedback,
  type ActivityFeedbackSummary,
} from "@artflow-plus/db";
import { DomainError, type ActorContext } from "@artflow-plus/domain";
import type { Kysely } from "kysely";

import { executeCommand, type CommandOutcome } from "./command.js";
import type { RuntimeDeps } from "./deps.js";
import { appendEngineEvent } from "./events.js";
import { idFromCommand } from "./hash.js";

/** Public feedback has no identity; the synthetic actor carries no permissions. */
const publicFeedbackActor: ActorContext = {
  actorId: "public-feedback",
  actorType: "system",
  roles: ["public"],
  permissions: [],
};

export interface SubmitFeedbackInput {
  readonly commandId: string;
  readonly publicCode: string;
  readonly rating: number;
  readonly comment: string;
}

export async function submitActivityFeedback(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: SubmitFeedbackInput,
): Promise<CommandOutcome<{ readonly status: "submitted" }>> {
  const activity = await getActivityByPublicCode(db, input.publicCode);
  if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
  const rating = Number.isInteger(input.rating) ? input.rating : Number.NaN;
  if (rating < 1 || rating > 5) {
    throw new DomainError("INVALID_INPUT", "Rating must be between 1 and 5.");
  }
  const comment = input.comment.trim();
  if (comment.length > 1000) {
    throw new DomainError("INVALID_INPUT", "Comment must be at most 1000 characters.");
  }
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: activity.id,
    capability: "engine",
    commandType: "activity.feedback.submit",
    actor: publicFeedbackActor,
    payload: { activityId: activity.id, rating, comment },
  }, async (trx) => {
    const current = await getActivityForUpdate(trx, activity.id);
    if (current === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
    if (current.status !== "closed") {
      throw new DomainError("INVALID_TRANSITION", "Feedback opens after the activity closes.");
    }
    const id = idFromCommand("feedback", input.commandId);
    await insertActivityFeedback(trx, {
      id,
      activityId: activity.id,
      rating,
      comment,
      source: "public",
      submittedAt: deps.now(),
    });
    await appendEngineEvent(trx, deps, {
      type: "ActivityFeedbackSubmitted",
      activityId: activity.id,
      aggregateType: "activity_feedback",
      aggregateId: id,
      revision: 0,
      payload: { feedbackId: id, rating },
    });
    return { body: { status: "submitted" as const }, status: 201 };
  });
}

export interface ActivityFeedbackView {
  readonly items: readonly StoredActivityFeedback[];
  readonly summary: ActivityFeedbackSummary;
}

export async function getActivityFeedback(
  db: Kysely<Database>,
  activityId: string,
): Promise<ActivityFeedbackView> {
  const [items, summary] = await Promise.all([
    listActivityFeedback(db, activityId),
    summarizeActivityFeedback(db, activityId),
  ]);
  return { items, summary };
}
