import {
  ActivityEventsSnapshotSchema,
  VotingSessionsSnapshotSchema,
} from "@artflow-plus/contracts";
import { getActivity, getActivityEventHead } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import {
  parseTopicString,
  type RealtimeActor,
  type RealtimeTopic,
} from "@artflow-plus/realtime/protocol";
import { readVotingSessionsState } from "@artflow-plus/runtime";
import type { Kysely } from "kysely";

function can(actor: RealtimeActor, permission: string): boolean {
  return actor.permissions.includes("*") || actor.permissions.includes(permission);
}

export function createVotingRealtimeTopic(db: Kysely<Database>): RealtimeTopic {
  return {
    namespace: "voting",
    parse(topic) {
      const parsed = parseTopicString(topic);
      if (parsed === null || parsed.namespace !== "voting") return null;
      return { activityId: parsed.rest, aggregateId: parsed.rest };
    },
    async authorize(actor, target) {
      return target.activityId.length > 0 && can(actor, "voting.manage");
    },
    async snapshot(target) {
      const data = await readVotingSessionsState(db, target.activityId);
      if (data === null) return null;
      const seq = Math.max(0, ...data.sessions.map((session) => session.live?.seq ?? 0));
      return { seq, data };
    },
    schema: VotingSessionsSnapshotSchema,
  };
}

export function createActivityRealtimeTopic(db: Kysely<Database>): RealtimeTopic {
  return {
    namespace: "activity",
    parse(topic) {
      const parsed = parseTopicString(topic);
      if (parsed === null || parsed.namespace !== "activity") return null;
      return { activityId: parsed.rest, aggregateId: parsed.rest };
    },
    async authorize(actor, target) {
      if (target.activityId.length === 0) return false;
      if (actor.roles.includes("admin")) return true;
      return (
        actor.permissions.includes("*") ||
        actor.permissions.includes("studio.manage") ||
        actor.permissions.includes("competition.manage") ||
        actor.permissions.includes("judge.manage")
      );
    },
    async snapshot(target) {
      const activity = await getActivity(db, target.activityId);
      if (activity === null) return null;
      const lastSequence = await getActivityEventHead(db, target.activityId);
      return { seq: lastSequence, data: { lastSequence } };
    },
    schema: ActivityEventsSnapshotSchema,
  };
}
