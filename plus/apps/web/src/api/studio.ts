import { apiFetch } from "./client.js";

export interface StudioActivity {
  readonly id: string;
  readonly publicCode: string;
  readonly title: string;
  readonly status: string;
  readonly revision: number;
  readonly enabledCapabilities: readonly string[];
  readonly activeDefinitionVersion: number;
}

export interface StudioDraft {
  readonly revision: number;
  readonly package: unknown;
}

export interface StudioCompiled {
  readonly draftRevision: number;
  readonly contentHash: string;
  readonly capabilities: readonly string[];
}

export interface StudioRelease {
  readonly version: number;
  readonly contentHash: string;
  readonly releasedAt: string;
  readonly sourceDraftRevision: number;
  readonly declaredScopes: readonly string[];
  readonly capabilityVersions: Readonly<Record<string, string>>;
  readonly active: boolean;
}

export interface StudioSession {
  readonly id: string;
  readonly activityId: string;
  readonly definitionVersion: number;
  readonly contentHash: string;
  readonly scope: string;
  readonly mode: "test" | "rehearsal" | "formal";
  readonly status: "running" | "closed";
  readonly revision: number;
  readonly openedAt: string;
  readonly closedAt?: string;
}

export interface StudioState {
  readonly activity: StudioActivity;
  readonly draft: StudioDraft | null;
  readonly compiled: StudioCompiled | null;
  readonly releases: readonly StudioRelease[];
  readonly sessions: readonly StudioSession[];
}

export interface PackQuestion {
  readonly id: string;
  readonly prompt: string;
  readonly capability: string;
  readonly default: boolean;
}

export interface ActivityPackSummary {
  readonly identity: string;
  readonly version: string;
  readonly title: string;
  readonly baselineCapabilities: readonly string[];
  readonly questions: readonly PackQuestion[];
}

export interface PackPreview {
  readonly pack: { readonly identity: string; readonly version: string };
  readonly enabledCapabilities: readonly string[];
  readonly definition: unknown;
}

export async function fetchStudioActivities(): Promise<readonly StudioActivity[]> {
  const response = await apiFetch<{ activities: readonly StudioActivity[] }>("/api/activities");
  return response.activities;
}

export function fetchStudioState(activityId: string): Promise<StudioState> {
  return apiFetch<StudioState>(`/api/activities/${activityId}/studio`);
}

export function fetchPacks(): Promise<readonly ActivityPackSummary[]> {
  return apiFetch<{ packs: readonly ActivityPackSummary[] }>("/api/packs").then(
    (response) => response.packs,
  );
}

export function previewPack(
  packId: string,
  input: { title: string; answers: Record<string, boolean> },
): Promise<PackPreview> {
  return apiFetch<PackPreview>(`/api/packs/${packId}/instantiate`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function createStudioActivity(
  commandId: string,
  input: { title: string; packId: string; answers: Record<string, boolean> },
): Promise<StudioActivity> {
  return apiFetch<StudioActivity>("/api/activities", {
    method: "POST",
    headers: { "idempotency-key": commandId },
    body: JSON.stringify(input),
  });
}

export function activateStudioActivity(
  activityId: string,
  commandId: string,
  expectedRevision: number,
): Promise<StudioActivity> {
  return apiFetch<StudioActivity>(`/api/activities/${activityId}/activate`, {
    method: "POST",
    headers: { "idempotency-key": commandId },
    body: JSON.stringify({ expectedRevision }),
  });
}

export function compileStudioDefinition(
  activityId: string,
  commandId: string,
  pkg: unknown,
  expectedDraftRevision?: number,
): Promise<{ draftRevision: number; contentHash: string; capabilities: string[] }> {
  return apiFetch(`/api/activities/${activityId}/definitions/compile`, {
    method: "POST",
    headers: { "idempotency-key": commandId },
    body: JSON.stringify({
      package: pkg,
      ...(expectedDraftRevision === undefined ? {} : { expectedDraftRevision }),
    }),
  });
}

export function releaseStudioDefinition(
  activityId: string,
  commandId: string,
  expectedDraftRevision: number,
): Promise<{ version: number; contentHash: string }> {
  return apiFetch(`/api/activities/${activityId}/definitions/release`, {
    method: "POST",
    headers: { "idempotency-key": commandId },
    body: JSON.stringify({ expectedDraftRevision }),
  });
}

export function startStudioSession(
  activityId: string,
  commandId: string,
  scope: string,
  mode: "test" | "rehearsal" | "formal",
): Promise<StudioSession> {
  return apiFetch<StudioSession>(`/api/activities/${activityId}/executions`, {
    method: "POST",
    headers: { "idempotency-key": commandId },
    body: JSON.stringify({ scope, mode }),
  });
}

export function closeStudioSession(
  activityId: string,
  sessionId: string,
  commandId: string,
  expectedRevision: number,
): Promise<StudioSession> {
  return apiFetch<StudioSession>(`/api/activities/${activityId}/executions/${sessionId}/close`, {
    method: "POST",
    headers: { "idempotency-key": commandId },
    body: JSON.stringify({ expectedRevision }),
  });
}
