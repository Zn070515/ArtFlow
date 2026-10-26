import type { Database, StoredRound } from "@artflow-plus/db";
import {
  deleteNonFormalRankingsForRound,
  deleteNonFormalScoreDataForRound,
  deletePerformancesForRound,
  existsFormalScoreFactsForRound,
  getActivityForUpdate,
  getRoundForUpdate,
  supersedeCurrentPanelForRound,
  updateRound,
} from "@artflow-plus/db";
import { DomainError, requirePermission } from "@artflow-plus/domain";
import type { Kysely } from "kysely";

import { executeCommand, type CommandOutcome } from "./command.js";
import { runtimeActor, type RuntimeDeps } from "./deps.js";
import { appendEngineEvent } from "./events.js";

export interface ResetRehearsalInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly roundId: string;
  readonly scope: string;
  readonly mode: "test" | "rehearsal";
}

export interface ResetRehearsalResult {
  readonly round: StoredRound;
  readonly deletedFacts: number;
  readonly deletedRankings: number;
  readonly deletedPerformances: number;
}

/**
 * Clears rehearsal-only data for one round and returns its shared lifecycle to
 * `prepared`. Formal facts are never touched; if any exist the reset is refused
 * because round/performance state is not mode-scoped.
 */
export async function resetRehearsalRound(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: ResetRehearsalInput,
): Promise<CommandOutcome<ResetRehearsalResult>> {
  const actor = runtimeActor(deps);
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "competition",
    commandType: "competition.rehearsal.reset",
    scope: input.scope,
    actor,
    payload: { roundId: input.roundId, scope: input.scope, mode: input.mode },
  }, async (trx) => {
    requirePermission(actor, "competition.manage");
    const activity = await getActivityForUpdate(trx, input.activityId);
    if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
    const round = await getRoundForUpdate(trx, input.roundId);
    if (round === null || round.activityId !== activity.id) {
      throw new DomainError("NOT_FOUND", "The competition round was not found.");
    }
    if (await existsFormalScoreFactsForRound(trx, round.id)) {
      throw new DomainError("FORMAL_FACTS_EXIST", "Formal score facts exist; rehearsal reset is refused.");
    }
    const deletedFacts = await deleteNonFormalScoreDataForRound(trx, round.id);
    const deletedRankings = await deleteNonFormalRankingsForRound(trx, round.id);
    const deletedPerformances = await deletePerformancesForRound(trx, round.id);
    await supersedeCurrentPanelForRound(trx, round.id);
    const saved = await updateRound(trx, {
      ...round,
      state: "prepared",
      revision: round.revision + 1,
      scoreVersion: 0,
      currentPanelId: null,
      lockedAt: null,
    }, round.revision);
    await appendEngineEvent(trx, deps, {
      type: "RehearsalRoundReset",
      activityId: activity.id,
      aggregateType: "competition_round",
      aggregateId: round.id,
      revision: saved.revision,
      capability: "competition",
      mode: input.mode,
      scope: input.scope,
      payload: {
        roundId: round.id,
        deletedFacts,
        deletedRankings,
        deletedPerformances,
        mode: input.mode,
      },
    });
    return { body: { round: saved, deletedFacts, deletedRankings, deletedPerformances } };
  });
}
