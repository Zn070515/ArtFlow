import { apiFetch } from "./client.js";

export interface ProgrammeItem {
  readonly order: number;
  readonly title: string;
  readonly performers: string;
  readonly notes: string;
}

export interface ProgrammeProjection {
  readonly activityTitle: string;
  readonly publicCode: string;
  readonly published: boolean;
  readonly emptyReason: "activity_not_active" | "roster_not_final" | "no_approved_programmes" | null;
  readonly items: readonly ProgrammeItem[];
}

export function fetchPublicProgramme(publicCode: string): Promise<ProgrammeProjection> {
  return apiFetch<ProgrammeProjection>(`/api/public/programme/${encodeURIComponent(publicCode)}`);
}

export function fetchHostProgramme(activityId: string): Promise<ProgrammeProjection> {
  return apiFetch<ProgrammeProjection>(`/api/activities/${encodeURIComponent(activityId)}/programme`);
}
