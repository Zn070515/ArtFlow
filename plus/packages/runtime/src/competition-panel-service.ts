import type {
  Database,
  StoredPanelSnapshot,
} from "@artflow-plus/db";
import {
  ensureJudgeEntrySeat,
  findJudgeSeatGrantBySeatKeyForUpdate,
  getActivityForUpdate,
  getCurrentPanelForUpdate,
  getNextPanelVersion,
  getRoundForUpdate,
  insertJudgeSeat,
  insertPanelMember,
  insertPanelSnapshot,
  listApprovedParticipantIds,
  reopenJudgeEntrySeat,
  revokeJudgeSessionsForSeat,
  updateRound,
} from "@artflow-plus/db";
import {
  DomainError,
} from "@artflow-plus/domain";
import type { Kysely } from "kysely";

import { executeCommand, type CommandOutcome } from "./command.js";
import { runtimeActor, type RuntimeDeps } from "./deps.js";
import { appendEngineEvent } from "./events.js";
import { idFromCommand, stableHash } from "./hash.js";


import {
  requireActive,
  requireRoundForActivity,
  requireSetupPermission,
  runningSession,
  type JudgeInput,
} from "./competition-shared.js";

export interface ActivateCompetitionPanelInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly roundId: string;
  readonly scope: string;
  readonly judges: readonly JudgeInput[];
}

export async function activateCompetitionPanel(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: ActivateCompetitionPanelInput,
): Promise<CommandOutcome<StoredPanelSnapshot>> {
  const actor = runtimeActor(deps);
  return executeCommand(
    db,
    {
      commandId: input.commandId,
      activityId: input.activityId,
      capability: "competition",
      commandType: "competition.panel.activate",
      scope: input.scope,
      actor,
      payload: { roundId: input.roundId, scope: input.scope, judges: input.judges },
    },
    async (trx) => {
      requireSetupPermission(actor);
      const activity = await getActivityForUpdate(trx, input.activityId);
      if (activity === null) throw new DomainError("NOT_FOUND", `Activity ${input.activityId} was not found.`);
      requireActive(activity);
      const round = requireRoundForActivity(await getRoundForUpdate(trx, input.roundId), input.activityId);
      if (await getCurrentPanelForUpdate(trx, round.id) !== null) {
        throw new DomainError("PANEL_ALREADY_ACTIVE", "The round already has a current panel.");
      }
      if (round.state !== "prepared") throw new DomainError("INVALID_TRANSITION", "Only a prepared round can activate its first panel.");
      if (input.judges.length !== round.judgeCount) {
        throw new DomainError("JUDGE_ROSTER_INVALID", `The panel requires exactly ${round.judgeCount} judges.`);
      }
      const judgeIds = new Set<string>();
      const seatKeys = new Set<string>();
      for (const judge of input.judges) {
        if (!judge.judgeId.trim() || !judge.seatKey.trim() || judgeIds.has(judge.judgeId) || seatKeys.has(judge.seatKey)) {
          throw new DomainError("JUDGE_ROSTER_INVALID", "Judge identities and seat keys must be nonempty and unique.");
        }
        judgeIds.add(judge.judgeId);
        seatKeys.add(judge.seatKey);
      }
      const { session } = await runningSession(trx, activity, "competition.panel.activate", input.scope);
      const panelId = idFromCommand("panel", input.commandId);
      const panel: StoredPanelSnapshot = {
        id: panelId,
        activityId: input.activityId,
        roundId: round.id,
        version: await getNextPanelVersion(trx, round.id),
        state: "active",
        expectedJudges: round.judgeCount,
        minimumJudges: round.minimumJudges,
        rosterDigest: stableHash(await listApprovedParticipantIds(trx, input.activityId)),
        contextVersion: 1,
        current: true,
      };
      await insertPanelSnapshot(trx, panel);
      for (const judge of input.judges) {
        await insertPanelMember(trx, { panelId, judgeId: judge.judgeId, seatKey: judge.seatKey });
        await insertJudgeSeat(trx, {
          id: idFromCommand("seat", `${panelId}:${judge.seatKey}`),
          panelId,
          judgeId: judge.judgeId,
          state: "assigned",
          revision: 0,
        });
        if (activity.enabledCapabilities.includes("ticketing")) {
          // With ticketing enabled, each panel seat becomes a claimable judge-entry
          // seat. The judge session binds to the entry seat; the seat key maps it
          // back to the current panel member for scoring. A seat key reused by the
          // next panel must release its previous claim: revoke the old session so
          // it cannot score the new panel, then reopen the seat.
          const existingGrant = await findJudgeSeatGrantBySeatKeyForUpdate(
            trx,
            input.activityId,
            judge.seatKey,
          );
          if (existingGrant === null) {
            await ensureJudgeEntrySeat(trx, {
              id: idFromCommand("judge-entry-seat", `${input.activityId}:${judge.seatKey}`),
              activityId: input.activityId,
              seatKey: judge.seatKey,
              state: "available",
              revision: 0,
            });
          } else if (existingGrant.state === "claimed") {
            await revokeJudgeSessionsForSeat(trx, existingGrant.id, deps.now());
            await reopenJudgeEntrySeat(trx, existingGrant);
          }
        }
      }
      const savedRound = await updateRound(trx, {
        ...round,
        state: "scoring",
        revision: round.revision + 1,
        currentPanelId: panelId,
      }, round.revision);
      await appendEngineEvent(trx, deps, {
        type: "PanelSnapshotActivated",
        activityId: input.activityId,
        aggregateType: "competition_round",
        aggregateId: round.id,
        revision: savedRound.revision,
        capability: "competition",
        mode: session.mode,
        scope: session.scope,
        payload: { panel, roundRevision: savedRound.revision },
      });
      return { body: panel, status: 201 };
    },
  );
}
