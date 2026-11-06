import type { CompiledGroupingArtifact } from "@artflow-plus/domain";
import { DomainError, requirePermission } from "@artflow-plus/domain";
import type { Database } from "@artflow-plus/db";
import {
  getActivity,
  getRelease,
  listCurrentGroupingMemberships,
  listGroupingGroups,
  listGroupingStages,
  listParticipantLabels,
} from "@artflow-plus/db";
import type { Kysely } from "kysely";

import { runtimeActor, type RuntimeDeps } from "./deps.js";

export interface GroupingStateView {
  readonly stages: readonly {
    readonly id: string;
    readonly stageKey: string;
    readonly name: string;
    readonly status: string;
    readonly rosterSource: string;
    readonly sourceRoundId: string | null;
    readonly materialWindow: string;
    readonly revision: number;
    readonly groupCount: number | null;
    readonly matchesGroupCount: boolean | null;
    readonly groups: readonly {
      readonly id: string;
      readonly order: number;
      readonly name: string;
      readonly members: readonly { readonly participantId: string; readonly displayName: string }[];
    }[];
  }[];
}

export async function getGroupingState(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: { readonly activityId: string },
): Promise<GroupingStateView> {
  requirePermission(runtimeActor(deps), "grouping.manage");
  const activity = await getActivity(db, input.activityId);
  if (activity === null) {
    throw new DomainError("NOT_FOUND", `Activity ${input.activityId} was not found.`);
  }
  if (!activity.enabledCapabilities.includes("grouping")) {
    throw new DomainError("CAPABILITY_NOT_ENABLED", "Capability grouping is not enabled on this activity.");
  }
  const stages = await listGroupingStages(db, activity.id);
  const stageIds = stages.map((stage) => stage.id);
  const groups = await listGroupingGroups(db, stageIds);
  const memberships = (
    await Promise.all(stageIds.map((stageId) => listCurrentGroupingMemberships(db, stageId)))
  ).flat();
  const labels = await listParticipantLabels(db, activity.id);
  let groupCount: number | null = null;
  if (activity.activeDefinitionVersion > 0) {
    const release = await getRelease(db, activity.id, activity.activeDefinitionVersion);
    const plan = release?.capabilities.grouping;
    if (plan !== undefined && plan.ok === true) {
      const artifact = plan.artifact as CompiledGroupingArtifact;
      groupCount = artifact.groupCount ?? null;
    }
  }
  return {
    stages: stages.map((stage) => {
      const stageGroups = groups.filter((group) => group.stageId === stage.id && group.isActive);
      const stageMembers = memberships.filter((member) => member.stageId === stage.id);
      return {
        id: stage.id,
        stageKey: stage.stageKey,
        name: stage.name,
        status: stage.status,
        rosterSource: stage.rosterSource,
        sourceRoundId: stage.sourceRoundId ?? null,
        materialWindow: stage.materialWindow,
        revision: stage.revision,
        groupCount,
        matchesGroupCount: groupCount === null ? null : stageGroups.length === groupCount,
        groups: stageGroups.map((group) => ({
          id: group.id,
          order: group.groupOrder,
          name: group.name,
          members: stageMembers
            .filter((member) => member.groupId === group.id)
            .map((member) => ({
              participantId: member.participantId,
              displayName: labels.get(member.participantId) ?? member.participantId,
            })),
        })),
      };
    }),
  };
}
