import {
  findRunningSessionByScope,
  getActivity,
  getCurrentRankingSnapshot,
  getLatestAdvancementDecision,
  getRound,
  listCurrentScoreFacts,
  listLatestCorrectionsForScoreFacts,
  listRoundPerformances,
} from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import type { CompetitionRoundScoresResponse } from "@artflow-plus/contracts";
import { DomainError } from "@artflow-plus/domain";
import type { Kysely } from "kysely";

export interface RoundScoresInput {
  readonly activityId: string;
  readonly roundId: string;
  readonly scope: string;
}

/** Permission checks belong to the route/topic caller; this reads the projection. */
export async function getRoundScores(
  db: Kysely<Database>,
  input: RoundScoresInput,
): Promise<CompetitionRoundScoresResponse> {
  if (input.scope !== "judging") {
    throw new DomainError("INVALID_INPUT", "Only the judging scope is supported.");
  }
  const activity = await getActivity(db, input.activityId);
  if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
  const round = await getRound(db, input.roundId);
  if (round === null || round.activityId !== activity.id) {
    throw new DomainError("NOT_FOUND", "The competition round was not found.");
  }
  const session = await findRunningSessionByScope(db, activity.id, input.scope);
  const mode = session?.mode ?? null;
  const facts = mode === null ? [] : await listCurrentScoreFacts(db, round.id, mode);
  const corrections = await listLatestCorrectionsForScoreFacts(db, facts.map((fact) => fact.id));
  const ranking = mode === null ? null : await getCurrentRankingSnapshot(db, round.id, mode);
  const advancement = await getLatestAdvancementDecision(db, round.id);
  const performances = await listRoundPerformances(db, round.id);

  return {
    round: {
      key: round.roundKey,
      state: round.state,
      revision: round.revision,
      scoreVersion: round.scoreVersion,
      advanceCount: round.advanceCount,
    },
    session: session === null ? null : { id: session.id, mode: session.mode, scope: session.scope },
    // rows/tieGroups are engine-written: decorateTieGroups adds tie ids and the
    // response contract validates the shape.
    ranking: ranking === null ? null : {
      id: ranking.id,
      revision: ranking.revision,
      status: ranking.status,
      inputFingerprint: ranking.inputFingerprint,
      rows: (ranking.rows as { contestantId: string; total: string; judgeCount: number }[]),
      tieGroups: (ranking.tieGroups as { id: string; total: string; contestants: string[] }[]),
    },
    // finalizeAdvancement writes contestantId/advanced; the response contract
    // validates the shape.
    advancement: advancement === null ? null : {
      id: advancement.id,
      revision: advancement.revision,
      status: advancement.status,
      inputFingerprint: advancement.inputFingerprint,
      decisions: (advancement.decisions as { contestantId: string; advanced: boolean }[]),
    },
    performances: performances.map((item) => ({
      id: item.id,
      contestantId: item.contestantId,
      sequence: item.sequence,
      state: item.state,
      contextVersion: item.contextVersion,
    })),
    facts: facts.map((fact) => {
      const correction = corrections.get(fact.id);
      return {
        id: fact.id,
        performanceId: fact.performanceId,
        contestantId: fact.contestantId,
        judgeId: fact.judgeId,
        seatId: fact.seatId,
        source: fact.source,
        total: fact.total,
        criteria: fact.criteria,
        notes: fact.notes,
        version: fact.version,
        contextVersion: fact.contextVersion,
        panelSnapshotId: fact.panelSnapshotId,
        correction: correction === undefined ? null : {
          id: correction.id,
          state: correction.state,
          baseVersion: correction.baseVersion,
          reason: correction.reason,
          revision: correction.revision,
        },
      };
    }),
  };
}
