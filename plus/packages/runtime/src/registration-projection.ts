import type { RuntimeEvent } from "@artflow-plus/domain";
import { deepFreeze, unknownRoster, type RegistrationStatus, type RosterState } from "@artflow-plus/domain";

export interface RegistrationProjectionRow {
  readonly id: string;
  readonly participantId: string;
  readonly status: RegistrationStatus;
  readonly revision: number;
}

export interface MaterialProjectionRow {
  readonly id: string;
  readonly registrationId: string;
  readonly questionKey: string;
  readonly status: "uploaded" | "approved" | "needs_supplement";
  readonly revision: number;
}

export interface RegistrationProjectionState {
  readonly activityId: string;
  readonly registrations: Readonly<Record<string, RegistrationProjectionRow>>;
  readonly materials: Readonly<Record<string, MaterialProjectionRow>>;
  readonly roster: RosterState;
}

export function emptyRegistrationProjection(activityId: string): RegistrationProjectionState {
  return deepFreeze({
    activityId,
    registrations: {},
    materials: {},
    roster: unknownRoster(),
  });
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Registration event payload must be an object.");
  }
  return value as Record<string, unknown>;
}

function stringField(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Registration event payload is missing ${key}.`);
  return value;
}

function numberField(payload: Record<string, unknown>, key: string): number {
  const value = payload[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`Registration event payload is missing non-negative integer ${key}.`);
  }
  return value;
}

export function applyRegistrationEvent(
  state: RegistrationProjectionState,
  event: RuntimeEvent,
): RegistrationProjectionState {
  if (event.activityId !== state.activityId) return state;
  const payload = record(event.payload);

  if (event.type === "RegistrationStarted") {
    const id = stringField(payload, "registrationId");
    if (state.registrations[id] !== undefined) return state;
    const next = {
      ...state.registrations,
      [id]: {
        id,
        participantId: stringField(payload, "participantId"),
        status: "draft" as const,
        revision: event.revision,
      },
    };
    return deepFreeze({ ...state, registrations: next });
  }

  if (event.type === "RegistrationSubmitted" || event.type === "RegistrationReviewed") {
    const id = stringField(payload, "registrationId");
    const current = state.registrations[id];
    if (current === undefined || current.revision >= event.revision) return state;
    const status = event.type === "RegistrationSubmitted"
      ? "submitted"
      : (payload.status as RegistrationStatus);
    if (!["submitted", "approved", "need_supplement", "rejected"].includes(status)) {
      throw new Error(`Registration event has unsupported status ${String(status)}.`);
    }
    return deepFreeze({
      ...state,
      registrations: {
        ...state.registrations,
        [id]: { ...current, status, revision: event.revision },
      },
    });
  }

  if (event.type === "MaterialUploaded" || event.type === "MaterialReviewed") {
    const id = stringField(payload, "materialId");
    const current = state.materials[id];
    if (current !== undefined && current.revision >= event.revision) return state;
    const status = event.type === "MaterialUploaded" ? "uploaded" : payload.status;
    if (status !== "uploaded" && status !== "approved" && status !== "needs_supplement") {
      throw new Error(`Material event has unsupported status ${String(status)}.`);
    }
    return deepFreeze({
      ...state,
      materials: {
        ...state.materials,
        [id]: {
          id,
          registrationId: stringField(payload, "registrationId"),
          questionKey: stringField(payload, "questionKey"),
          status,
          revision: event.revision,
        },
      },
    });
  }

  if (event.type === "RosterFinalized") {
    if (state.roster.status === "final" && state.roster.revision >= event.revision) return state;
    return deepFreeze({
      ...state,
      roster: {
        status: "final",
        revision: event.revision,
        approvedCount: numberField(payload, "approvedCount"),
        finalizedAt: stringField(payload, "finalizedAt"),
      },
    });
  }

  return state;
}
