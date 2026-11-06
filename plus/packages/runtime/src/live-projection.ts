import { deepFreeze } from "@artflow-plus/domain";
import type { RuntimeEvent } from "@artflow-plus/domain";

export interface VotingLiveState {
  readonly activityId: string;
  readonly sessionId: string;
  readonly status: "open" | "closed";
  readonly optionIds: readonly string[];
  readonly counts: Readonly<Record<string, number>>;
  /** The projection is never the closed-session authority. */
  readonly authoritative: false;
  readonly lastEventType: string;
}

function objectPayload(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Voting live payload must be an object.");
  return value as Record<string, unknown>;
}

function stringField(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Voting live payload is missing ${key}.`);
  return value;
}

function stringArrayField(payload: Record<string, unknown>, key: string): readonly string[] {
  const value = payload[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) throw new Error(`Voting live payload is missing ${key}.`);
  return value as string[];
}

export function applyVotingLiveEvent(
  state: VotingLiveState | null,
  event: RuntimeEvent,
): VotingLiveState | null {
  if (event.type !== "VoteSessionOpened" && event.type !== "BallotSubmitted" && event.type !== "VoteSessionClosed") return state;
  const payload = objectPayload(event.payload);
  const sessionId = stringField(payload, "sessionId");
  if (event.type === "VoteSessionOpened") {
    const optionIds = stringArrayField(payload, "optionIds");
    const counts = Object.fromEntries(optionIds.map((optionId) => [optionId, 0]));
    return deepFreeze({ activityId: event.activityId, sessionId, status: "open", optionIds, counts, authoritative: false as const, lastEventType: event.type });
  }
  if (state === null || state.sessionId !== sessionId || state.activityId !== event.activityId) throw new Error("Voting live event has no matching session projection.");
  if (event.type === "BallotSubmitted") {
    const optionIds = stringArrayField(payload, "optionIds");
    const counts: Record<string, number> = { ...state.counts };
    for (const optionId of optionIds) {
      if (!state.optionIds.includes(optionId)) throw new Error("Voting live event names an unknown option.");
      counts[optionId] = (counts[optionId] ?? 0) + 1;
    }
    return deepFreeze({ ...state, counts, lastEventType: event.type });
  }
  return deepFreeze({ ...state, status: "closed", lastEventType: event.type });
}
