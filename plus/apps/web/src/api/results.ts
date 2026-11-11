import { ApiError, apiFetch } from "./client.js";

export interface PodiumPreviewView {
  readonly status: "candidate" | "hold";
  readonly placements: readonly {
    readonly place: number;
    readonly contestantId: string;
    readonly total: string;
  }[];
  readonly inputFingerprint: string;
  readonly roundIds: readonly string[];
  readonly blockedReason: "unresolved_ties" | "rounds_not_ready" | null;
}

export interface PublishingStageView {
  readonly key: string;
  readonly label: string;
}

export interface StageResultView {
  readonly stageKey: string;
  readonly status: string;
  readonly candidateRevision: number;
}

export interface PublishingDetailView {
  readonly stages: readonly PublishingStageView[];
  readonly stageResults: readonly StageResultView[];
  readonly releases: readonly { readonly stageKey: string; readonly status: string }[];
}

export interface StoredPodiumView {
  readonly status: "candidate" | "hold";
  readonly revision: number;
  readonly inputFingerprint: string;
}

function commandHeaders(): Record<string, string> {
  return { "idempotency-key": crypto.randomUUID() };
}

export function previewPodium(activityId: string, scope: string): Promise<PodiumPreviewView> {
  const params = new URLSearchParams({ scope });
  return apiFetch<PodiumPreviewView>(
    `/api/activities/${encodeURIComponent(activityId)}/competition/podium?${params.toString()}`,
  );
}

export function recomputePodium(
  activityId: string,
  input: {
    readonly scope: string;
    readonly roundIds: readonly string[];
    readonly expectedInputFingerprint: string;
  },
): Promise<StoredPodiumView> {
  return apiFetch<StoredPodiumView>(
    `/api/activities/${encodeURIComponent(activityId)}/competition/podium/recompute`,
    {
      method: "POST",
      headers: commandHeaders(),
      body: JSON.stringify(input),
    },
  );
}

export function confirmStageResult(
  activityId: string,
  stageKey: string,
  input: { readonly expectedSourceRevision: number; readonly expectedInputFingerprint: string },
): Promise<{ readonly candidateRevision: number }> {
  return apiFetch(
    `/api/activities/${encodeURIComponent(activityId)}/publishing/stage-results/${encodeURIComponent(stageKey)}/confirm`,
    {
      method: "POST",
      headers: commandHeaders(),
      body: JSON.stringify({
        scope: "publishing",
        expectedSourceRevision: input.expectedSourceRevision,
        expectedInputFingerprint: input.expectedInputFingerprint,
        awards: [],
      }),
    },
  );
}

export function releaseStageResult(
  activityId: string,
  stageKey: string,
  expectedCandidateRevision: number,
  note: string,
): Promise<unknown> {
  return apiFetch(`/api/activities/${encodeURIComponent(activityId)}/publishing/releases`, {
    method: "POST",
    headers: commandHeaders(),
    body: JSON.stringify({
      stageKey,
      scope: "publishing",
      expectedCandidateRevision,
      note,
    }),
  });
}

export function fetchPublishingDetail(activityId: string): Promise<PublishingDetailView> {
  return apiFetch<PublishingDetailView>(`/api/activities/${encodeURIComponent(activityId)}/publishing/state`);
}

export function closeActivity(
  activityId: string,
  expectedRevision: number,
): Promise<{ readonly revision: number; readonly status: string }> {
  return apiFetch(`/api/activities/${encodeURIComponent(activityId)}/close`, {
    method: "POST",
    headers: commandHeaders(),
    body: JSON.stringify({ expectedRevision }),
  });
}

export function archiveActivity(
  activityId: string,
  expectedRevision: number,
  note: string,
): Promise<{ readonly package: { readonly version: number } }> {
  return apiFetch(`/api/activities/${encodeURIComponent(activityId)}/archive`, {
    method: "POST",
    headers: commandHeaders(),
    body: JSON.stringify({ expectedRevision, note }),
  });
}

export function fetchArchiveState(
  activityId: string,
): Promise<{ readonly packages: readonly { readonly version: number; readonly isCurrent: boolean }[] }> {
  return apiFetch(`/api/activities/${encodeURIComponent(activityId)}/archive`);
}

export async function downloadArchiveFile(activityId: string): Promise<void> {
  const response = await fetch(`/api/activities/${encodeURIComponent(activityId)}/archive/file`, {
    credentials: "same-origin",
  });
  if (!response.ok) {
    let body: { code?: string; message?: string } = {};
    try {
      body = (await response.json()) as typeof body;
    } catch {
      // The file endpoint may answer with an empty body.
    }
    throw new ApiError(response.status, body.code ?? "REQUEST_FAILED", body.message ?? "归档包下载失败。");
  }
  const blob = await response.blob();
  const disposition = response.headers.get("content-disposition") ?? "";
  const match = /filename="([^"]+)"/.exec(disposition);
  const filename = match?.[1] ?? "archive.zip";
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
