import { apiFetch } from "./client.js";

export interface ArchivePackageView {
  readonly id: string;
  readonly activityId: string;
  readonly version: number;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly note: string;
  readonly sealedAt: string;
  readonly sealedBy: string;
  readonly isCurrent: boolean;
}

export interface ArchiveStateView {
  readonly activity: { readonly id: string; readonly title: string; readonly status: string };
  readonly packages: readonly ArchivePackageView[];
}

export function fetchArchiveState(activityId: string): Promise<ArchiveStateView> {
  return apiFetch<ArchiveStateView>(`/api/activities/${encodeURIComponent(activityId)}/archive`);
}

export function archiveFileUrl(activityId: string, version?: number): string {
  const base = `/api/activities/${encodeURIComponent(activityId)}/archive/file`;
  return version === undefined ? base : `${base}?version=${version}`;
}
