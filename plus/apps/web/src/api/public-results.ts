export interface PublicDecision {
  readonly rank: number;
  readonly contestantId: string;
  readonly score: string;
  readonly unit?: "score" | "percent";
}

export interface PublicAward {
  readonly award: string;
  readonly contestantId: string;
}

export interface PublicResult {
  readonly releaseId: string;
  readonly stageKey: string;
  readonly publicTitle: string;
  readonly releasedAt: string;
  readonly decisions: readonly PublicDecision[];
  readonly awards: readonly PublicAward[];
}

export interface PublicResults {
  readonly activity: { readonly publicCode: string };
  readonly activityTitle: string;
  readonly results: readonly PublicResult[];
}

export class PublicResultsNotFound extends Error {
  constructor(publicCode: string) {
    super(`No public results for ${publicCode}`);
    this.name = "PublicResultsNotFound";
  }
}

export async function fetchPublicResults(
  publicCode: string,
  signal?: AbortSignal,
): Promise<PublicResults> {
  const response = await fetch(`/api/public/results/${encodeURIComponent(publicCode)}`, {
    signal,
    headers: { accept: "application/json" },
  });
  if (response.status === 404) throw new PublicResultsNotFound(publicCode);
  if (!response.ok) throw new Error(`加载赛果失败（${response.status}）`);
  return (await response.json()) as PublicResults;
}
