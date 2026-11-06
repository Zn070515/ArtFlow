import { apiFetch } from "./client.js";

export interface GroupingMember {
  readonly participantId: string;
  readonly displayName: string;
}

export interface GroupingGroup {
  readonly id: string;
  readonly order: number;
  readonly name: string;
  readonly members: readonly GroupingMember[];
}

export interface GroupingStage {
  readonly id: string;
  readonly stageKey: string;
  readonly name: string;
  readonly status: "draft" | "confirmed" | "frozen" | "cancelled";
  readonly rosterSource: "all_approved" | "round_advanced";
  readonly sourceRoundId: string | null;
  readonly materialWindow: "closed" | "open" | "supplement_only";
  readonly revision: number;
  readonly groupCount: number | null;
  readonly matchesGroupCount: boolean | null;
  readonly groups: readonly GroupingGroup[];
}

export interface GroupingState {
  readonly stages: readonly GroupingStage[];
}

export type GroupingWindow = "closed" | "open" | "supplement_only";

export async function fetchGrouping(activityId: string): Promise<GroupingState> {
  return apiFetch<GroupingState>(`/api/activities/${activityId}/grouping`);
}

export async function createGroupingStage(
  activityId: string,
  commandId: string,
  input: { stageKey: string; name: string; rosterSource: "all_approved" | "round_advanced" },
): Promise<GroupingStage> {
  return apiFetch<GroupingStage>(`/api/activities/${activityId}/grouping/stages`, {
    method: "POST",
    headers: { "idempotency-key": commandId },
    body: JSON.stringify(input),
  });
}

export async function recordGroupingGroups(
  activityId: string,
  stageId: string,
  commandId: string,
  expectedRevision: number,
  groups: readonly { name?: string; participantIds: readonly string[] }[],
): Promise<GroupingStage> {
  return apiFetch<GroupingStage>(
    `/api/activities/${activityId}/grouping/stages/${stageId}/groups`,
    {
      method: "PATCH",
      headers: { "idempotency-key": commandId },
      body: JSON.stringify({ expectedRevision, groups }),
    },
  );
}

export async function confirmGroupingStage(
  activityId: string,
  stageId: string,
  commandId: string,
  expectedRevision: number,
): Promise<GroupingStage> {
  return apiFetch<GroupingStage>(
    `/api/activities/${activityId}/grouping/stages/${stageId}/confirm`,
    {
      method: "POST",
      headers: { "idempotency-key": commandId },
      body: JSON.stringify({ expectedRevision }),
    },
  );
}

export async function freezeGroupingStage(
  activityId: string,
  stageId: string,
  commandId: string,
  expectedRevision: number,
): Promise<GroupingStage> {
  return apiFetch<GroupingStage>(
    `/api/activities/${activityId}/grouping/stages/${stageId}/freeze`,
    {
      method: "POST",
      headers: { "idempotency-key": commandId },
      body: JSON.stringify({ expectedRevision }),
    },
  );
}

export async function correctGroupingStage(
  activityId: string,
  stageId: string,
  commandId: string,
  expectedRevision: number,
  groups: readonly { name?: string; participantIds: readonly string[] }[],
  reason: string,
): Promise<GroupingStage> {
  return apiFetch<GroupingStage>(
    `/api/activities/${activityId}/grouping/stages/${stageId}/correct`,
    {
      method: "POST",
      headers: { "idempotency-key": commandId },
      body: JSON.stringify({ expectedRevision, groups, reason }),
    },
  );
}

export async function cancelGroupingStage(
  activityId: string,
  stageId: string,
  commandId: string,
  expectedRevision: number,
  reason: string,
): Promise<GroupingStage> {
  return apiFetch<GroupingStage>(
    `/api/activities/${activityId}/grouping/stages/${stageId}/cancel`,
    {
      method: "POST",
      headers: { "idempotency-key": commandId },
      body: JSON.stringify({ expectedRevision, reason }),
    },
  );
}

export async function setGroupingWindow(
  activityId: string,
  stageId: string,
  commandId: string,
  expectedRevision: number,
  window: GroupingWindow,
): Promise<GroupingStage> {
  return apiFetch<GroupingStage>(
    `/api/activities/${activityId}/grouping/stages/${stageId}/window`,
    {
      method: "PATCH",
      headers: { "idempotency-key": commandId },
      body: JSON.stringify({ expectedRevision, window }),
    },
  );
}
