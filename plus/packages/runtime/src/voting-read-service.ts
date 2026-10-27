import type { Database } from "@artflow-plus/db";
import {
  getActivity,
  getLiveState,
  getVoteSession,
  hasBallotForIdentity,
  listVoteOptions,
  listVoteSessionsForActivity,
} from "@artflow-plus/db";
import type { Kysely } from "kysely";

import { stableHash } from "./hash.js";
import type { VotingLiveState } from "./live-projection.js";

export interface VotingSessionsState {
  readonly activityId: string;
  readonly sessions: readonly {
    readonly id: string;
    readonly status: "open" | "closed";
    readonly mode: string;
    readonly revision: number;
    readonly candidateCount: number;
    readonly candidates: readonly {
      readonly optionId: string;
      readonly candidateId: string;
      readonly ordinal: number;
    }[];
    readonly live: {
      readonly seq: number;
      readonly counts: Readonly<Record<string, number>>;
      readonly lastEventType: string;
    } | null;
  }[];
}

/** Permission checks belong to the route/topic caller; this reads the projection. */
export async function readVotingSessionsState(
  db: Kysely<Database>,
  activityId: string,
): Promise<VotingSessionsState | null> {
  const activity = await getActivity(db, activityId);
  if (activity === null) return null;
  const sessions = await listVoteSessionsForActivity(db, activityId);
  const result: Array<VotingSessionsState["sessions"][number]> = [];
  for (const session of sessions) {
    const options = await listVoteOptions(db, session.id);
    const live = await getLiveState(db, activityId, "vote_session", session.id);
    const state = live?.state as VotingLiveState | null | undefined;
    result.push({
      id: session.id,
      status: session.status === "closed" ? "closed" : "open",
      mode: session.mode,
      revision: session.revision,
      candidateCount: options.length,
      candidates: options.map((option) => ({
        optionId: option.id,
        candidateId: option.candidateId,
        ordinal: option.ordinal,
      })),
      live:
        live === null || state === null || state === undefined
          ? null
          : {
              seq: live.lastSequence,
              counts: state.counts,
              lastEventType: state.lastEventType,
            },
    });
  }
  return { activityId, sessions: result };
}

export interface PublicVoteSessionState {
  readonly activityId: string;
  readonly activityTitle: string;
  readonly sessionId: string;
  readonly status: "open" | "closed";
  readonly selectionType: "single" | "multi";
  readonly maxSelections: number;
  readonly identityPolicy: "browser" | "ticket" | "anonymous";
  readonly candidates: readonly {
    readonly optionId: string;
    readonly candidateId: string;
  }[];
  readonly voted: boolean;
}

/** A formal session that can be shared publicly; never exposes tallies or identities. */
export async function readPublicVoteSession(
  db: Kysely<Database>,
  sessionId: string,
  browserFingerprint?: string,
): Promise<PublicVoteSessionState | null> {
  const session = await getVoteSession(db, sessionId);
  // Only formal sessions that have actually been opened or closed are public;
  // a draft is not shareable yet, and treating it as open would render a vote
  // button that can only fail on submit.
  if (session === null || session.mode !== "formal" || session.status === "draft") return null;
  const activity = await getActivity(db, session.activityId);
  if (activity === null) return null;
  const options = await listVoteOptions(db, sessionId);
  let voted = false;
  if (
    session.identityPolicy === "browser" &&
    browserFingerprint !== undefined &&
    browserFingerprint.length >= 32
  ) {
    voted = await hasBallotForIdentity(db, sessionId, stableHash(browserFingerprint));
  }
  return {
    activityId: activity.id,
    activityTitle: activity.title,
    sessionId: session.id,
    status: session.status === "closed" ? "closed" : "open",
    selectionType: session.selectionType,
    maxSelections: session.maxSelections,
    identityPolicy: session.identityPolicy,
    candidates: options.map((option) => ({
      optionId: option.id,
      candidateId: option.candidateId,
    })),
    voted,
  };
}
