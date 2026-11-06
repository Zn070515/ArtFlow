import type { LiveRanking, LiveRankingRow } from "../../api/live.js";

export function liveDisplayRanks(
  rows: readonly LiveRankingRow[],
  tieGroups: readonly LiveRanking["tieGroups"][number][],
): readonly number[] {
  const ranks = new Map<string, number>();
  for (const group of tieGroups) {
    const firstIndex = rows.findIndex((row) => group.contestants.includes(row.contestantId));
    if (firstIndex < 0) continue;
    for (const contestantId of group.contestants) {
      ranks.set(contestantId, firstIndex + 1);
    }
  }
  return rows.map((row, index) => ranks.get(row.contestantId) ?? index + 1);
}
