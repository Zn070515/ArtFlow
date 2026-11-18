export interface OnsiteActionInput {
  readonly siteStatus: "active" | "closed";
  readonly currentStatus?: "active" | "closed";
  readonly hasCurrent: boolean;
  readonly voteOpen: boolean;
  readonly hasResults: boolean;
  readonly registrationOpen: boolean;
}

export type OnsitePrimary = "vote" | "results" | "join" | null;

export interface OnsiteActionsState {
  readonly live: boolean;
  readonly primary: OnsitePrimary;
}

export function deriveOnsiteActions(input: OnsiteActionInput): OnsiteActionsState {
  const status = input.currentStatus ?? input.siteStatus;
  const live = status === "active" && input.hasCurrent;
  if (status === "active" && input.voteOpen) return { live, primary: "vote" };
  if (input.hasResults) return { live, primary: "results" };
  if (status === "active" && input.registrationOpen) return { live, primary: "join" };
  return { live, primary: null };
}

export interface ProgramMatchEntry {
  readonly order: number;
  readonly name: string;
  readonly song: string;
}

export interface CurrentProgramMatch {
  readonly order: number;
  readonly title: string;
  readonly slotLabel: string;
}

export function matchCurrentProgramOrder(
  entries: readonly ProgramMatchEntry[],
  current: CurrentProgramMatch | null,
): number | null {
  if (current === null) return null;
  const byOrder = entries.find((entry) => entry.order === current.order);
  if (byOrder !== undefined) return byOrder.order;
  const byName = entries.find(
    (entry) => entry.name === current.title && entry.song === current.slotLabel,
  );
  return byName?.order ?? null;
}

export interface CandidateDisplay {
  readonly candidateId: string;
  readonly candidateName?: string;
}

const opaquePrefixed = /^[a-z][a-z0-9]*_[0-9a-f]{16,}$/i;
const opaqueUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function looksOpaqueId(value: string): boolean {
  return opaquePrefixed.test(value) || opaqueUuid.test(value);
}

export function displayCandidateName(candidate: CandidateDisplay, ordinal: number): string {
  const resolved = candidate.candidateName?.trim() ?? "";
  if (resolved !== "") return resolved;
  return looksOpaqueId(candidate.candidateId) ? `候选 ${ordinal}` : candidate.candidateId;
}

export function formatFreshness(updatedAt: number | undefined, now: number): string {
  if (updatedAt === undefined || !Number.isFinite(updatedAt)) return "";
  const seconds = Math.max(0, Math.floor((now - updatedAt) / 1_000));
  if (seconds < 10) return "刚刚更新";
  if (seconds < 60) return `${seconds} 秒前更新`;
  return `${Math.floor(seconds / 60)} 分钟前更新`;
}
