import type {
  CompiledGroupingArtifact,
  GroupingMaterialWindow,
  GroupingRosterSource,
} from "@artflow-plus/domain";
import {
  DomainError,
  normalizeGroupingGroups,
  requirePermission,
} from "@artflow-plus/domain";
import type { Database, StoredGroupingStage } from "@artflow-plus/db";
import {
  closeCurrentGroupingMemberships,
  deactivateGroupingGroups,
  deleteGroupingGroups,
  getActivityForUpdate,
  getGroupingStageByKey,
  getGroupingStageForUpdate,
  getLatestAdvancementDecision,
  getRelease,
  getRoster,
  getRound,
  insertGroupingGroup,
  insertGroupingMembership,
  insertGroupingStage,
  listApprovedParticipantIds,
  listCurrentGroupingMemberships,
  listGroupingGroups,
  updateGroupingGroup,
  updateGroupingStage,
} from "@artflow-plus/db";
import type { Kysely, Transaction } from "kysely";

import { executeCommand, type CommandOutcome } from "./command.js";
import { runtimeActor, type RuntimeDeps } from "./deps.js";
import { appendEngineEvent } from "./events.js";
import { idFromCommand, stableHash } from "./hash.js";
import { requireNoConsumedGrouping } from "./result-consumption.js";

const ROSTER_SOURCES: ReadonlySet<string> = new Set(["all_approved", "round_advanced"]);
const WINDOWS: ReadonlySet<string> = new Set(["closed", "open", "supplement_only"]);

function requireGroupingPermission(actor: Parameters<typeof requirePermission>[0]): void {
  requirePermission(actor, "grouping.manage");
}

function requireCapability(activity: { readonly enabledCapabilities: readonly string[] }): void {
  if (!activity.enabledCapabilities.includes("grouping")) {
    throw new DomainError("CAPABILITY_NOT_ENABLED", "Capability grouping is not enabled on this activity.");
  }
}

function requireNotArchived(activity: { readonly status: string }): void {
  if (activity.status === "archived") {
    throw new DomainError("ACTIVITY_ARCHIVED", "An archived activity cannot change its grouping.");
  }
}

function requireRevision(
  current: { readonly revision: number },
  expectedRevision: number,
): void {
  if (current.revision !== expectedRevision) {
    throw new DomainError("STALE_REVISION", "The grouping stage changed since it was read.");
  }
}

function requireDraft(stage: StoredGroupingStage): void {
  if (stage.status !== "draft") {
    throw new DomainError("GROUPING_NOT_DRAFT", "Only a draft grouping stage can record groups.");
  }
}

function requireReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed === "") {
    throw new DomainError("INVALID_INPUT", "A reason is required.");
  }
  return trimmed;
}

interface ResolvedGroupingSource {
  readonly participantIds: readonly string[];
  readonly fingerprint: string;
}

function advancementParticipantIds(decisions: readonly unknown[]): readonly string[] {
  const ids: string[] = [];
  for (const item of decisions) {
    if (item === null || typeof item !== "object") {
      throw new DomainError("GROUPING_SOURCE_UNKNOWN", "The advancement decision is malformed.");
    }
    const row = item as { contestantId?: unknown; advanced?: unknown };
    if (typeof row.contestantId !== "string") {
      throw new DomainError("GROUPING_SOURCE_UNKNOWN", "The advancement decision is malformed.");
    }
    if (row.advanced === true) ids.push(row.contestantId);
  }
  return ids.sort();
}

async function resolveGroupingSource(
  trx: Kysely<Database>,
  activityId: string,
  stage: Pick<StoredGroupingStage, "rosterSource" | "sourceRoundId">,
): Promise<ResolvedGroupingSource> {
  if (stage.rosterSource === "all_approved") {
    const roster = await getRoster(trx, activityId);
    if (roster.status !== "final") {
      throw new DomainError("GROUPING_SOURCE_UNKNOWN", "The participant roster is not final.");
    }
    const participantIds = await listApprovedParticipantIds(trx, activityId);
    if (participantIds.length !== roster.approvedCount) {
      throw new DomainError("GROUPING_SOURCE_CHANGED", "The approved roster changed since it was finalized.");
    }
    return {
      participantIds,
      fingerprint: stableHash({
        source: "all_approved",
        rosterRevision: roster.revision,
        finalizedAt: roster.finalizedAt,
        participantIds,
      }),
    };
  }
  if (stage.sourceRoundId === undefined) {
    throw new DomainError("GROUPING_SOURCE_UNKNOWN", "A round-sourced stage must name its round.");
  }
  const round = await getRound(trx, stage.sourceRoundId);
  if (round === null || round.activityId !== activityId) {
    throw new DomainError("NOT_FOUND", "The source round was not found in this activity.");
  }
  const decision = await getLatestAdvancementDecision(trx, round.id);
  if (decision === null || decision.status !== "auto") {
    throw new DomainError("GROUPING_SOURCE_UNKNOWN", "The source round has no final advancement decision.");
  }
  const participantIds = advancementParticipantIds(decision.decisions);
  return {
    participantIds,
    fingerprint: stableHash({
      source: "round_advanced",
      roundId: round.id,
      decisionId: decision.id,
      decisionRevision: decision.revision,
      inputFingerprint: decision.inputFingerprint,
      participantIds,
    }),
  };
}

async function compiledGroupCount(
  trx: Kysely<Database>,
  activity: {
    readonly id: string;
    readonly activeDefinitionVersion: number;
    readonly enabledCapabilities: readonly string[];
  },
): Promise<number | undefined> {
  if (activity.activeDefinitionVersion < 1) return undefined;
  if (!activity.enabledCapabilities.includes("grouping")) return undefined;
  const release = await getRelease(trx, activity.id, activity.activeDefinitionVersion);
  const plan = release?.capabilities.grouping;
  if (plan === undefined || plan.ok !== true) return undefined;
  return (plan.artifact as CompiledGroupingArtifact).groupCount;
}

async function stageGroups(
  trx: Transaction<Database>,
  stage: StoredGroupingStage,
): Promise<{
  readonly groups: readonly {
    readonly id: string;
    readonly groupOrder: number;
    readonly name: string;
    readonly participantIds: readonly string[];
  }[];
}> {
  const groups = (await listGroupingGroups(trx, [stage.id])).filter((group) => group.isActive);
  const members = await listCurrentGroupingMemberships(trx, stage.id);
  return {
    groups: groups.map((group) => ({
      id: group.id,
      groupOrder: group.groupOrder,
      name: group.name,
      participantIds: members
        .filter((member) => member.groupId === group.id)
        .map((member) => member.participantId),
    })),
  };
}

interface SaveGroupsOptions {
  readonly clearExisting: boolean;
  readonly reason: string;
  readonly actorId: string;
  readonly leftAt: string;
  /** The command id keeps derived ids deterministic under replay. */
  readonly nonce: string;
}

async function saveGroups(
  trx: Transaction<Database>,
  stage: StoredGroupingStage,
  normalized: readonly { readonly name: string; readonly participantIds: readonly string[] }[],
  options: SaveGroupsOptions,
): Promise<void> {
  if (options.clearExisting) {
    await deleteGroupingGroups(trx, stage.id);
  } else {
    await closeCurrentGroupingMemberships(trx, stage.id, options.leftAt, options.actorId, options.reason);
  }
  const existing = options.clearExisting
    ? []
    : (await listGroupingGroups(trx, [stage.id])).filter((group) => group.isActive);
  const byOrder = new Map(existing.map((group) => [group.groupOrder, group]));
  const kept: string[] = [];
  for (const [index, group] of normalized.entries()) {
    const groupOrder = index + 1;
    const current = byOrder.get(groupOrder);
    const groupId = current?.id ?? idFromCommand("grouping_group", `${stage.id}:${index}:${options.nonce}`);
    if (current === undefined) {
      await insertGroupingGroup(trx, {
        id: groupId,
        stageId: stage.id,
        groupOrder,
        name: group.name,
        isActive: true,
      }, options.leftAt);
    } else {
      await updateGroupingGroup(trx, {
        id: groupId,
        stageId: stage.id,
        groupOrder,
        name: group.name,
        isActive: true,
      });
    }
    kept.push(groupId);
    for (const participantId of group.participantIds) {
      await insertGroupingMembership(trx, {
        id: idFromCommand("grouping_member", `${stage.id}:${index}:${participantId}:${options.nonce}`),
        stageId: stage.id,
        groupId,
        participantId,
        isCurrent: true,
        joinedAt: options.leftAt,
        reason: options.reason,
      });
    }
  }
  await deactivateGroupingGroups(trx, stage.id, kept);
}

export interface CreateGroupingStageInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly stageKey: string;
  readonly name: string;
  readonly rosterSource: GroupingRosterSource;
  readonly sourceRoundId?: string;
}

export async function createGroupingStage(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: CreateGroupingStageInput,
): Promise<CommandOutcome<StoredGroupingStage>> {
  const actor = runtimeActor(deps);
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "grouping",
    commandType: "grouping.stage.create",
    actor,
    payload: {
      stageKey: input.stageKey,
      name: input.name,
      rosterSource: input.rosterSource,
      sourceRoundId: input.sourceRoundId ?? null,
    },
  }, async (trx) => {
    requireGroupingPermission(actor);
    const activity = await getActivityForUpdate(trx, input.activityId);
    if (activity === null) throw new DomainError("NOT_FOUND", `Activity ${input.activityId} was not found.`);
    requireNotArchived(activity);
    requireCapability(activity);
    const stageKey = input.stageKey.trim();
    const name = input.name.trim();
    if (stageKey === "" || name === "") {
      throw new DomainError("INVALID_INPUT", "A stage needs a key and a name.");
    }
    if (!ROSTER_SOURCES.has(input.rosterSource)) {
      throw new DomainError("INVALID_INPUT", "Unknown roster source.");
    }
    if (input.rosterSource === "round_advanced") {
      if (input.sourceRoundId === undefined) {
        throw new DomainError("INVALID_INPUT", "A round-sourced stage must name its round.");
      }
      const round = await getRound(trx, input.sourceRoundId);
      if (round === null || round.activityId !== activity.id) {
        throw new DomainError("NOT_FOUND", "The source round was not found in this activity.");
      }
    } else if (input.sourceRoundId !== undefined) {
      throw new DomainError("INVALID_INPUT", "An all-approved stage cannot name a source round.");
    }
    if ((await getGroupingStageByKey(trx, activity.id, stageKey)) !== null) {
      throw new DomainError("GROUPING_STAGE_EXISTS", `Stage ${stageKey} already exists.`);
    }
    const stage: StoredGroupingStage = {
      id: idFromCommand("grouping_stage", input.commandId),
      activityId: activity.id,
      stageKey,
      name,
      status: "draft",
      rosterSource: input.rosterSource,
      ...(input.sourceRoundId === undefined ? {} : { sourceRoundId: input.sourceRoundId }),
      sourceFingerprint: "",
      materialWindow: "closed",
      cancelReason: "",
      revision: 1,
    };
    await insertGroupingStage(trx, stage, deps.now());
    await appendEngineEvent(trx, deps, {
      type: "GroupingStageCreated",
      activityId: activity.id,
      aggregateType: "grouping_stage",
      aggregateId: stage.id,
      capability: "grouping",
      revision: stage.revision,
      payload: { stageId: stage.id, stageKey, rosterSource: stage.rosterSource },
    });
    return { body: stage, status: 201 };
  });
}

export interface RecordGroupingGroupsInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly stageId: string;
  readonly expectedRevision: number;
  readonly groups: readonly { readonly name?: string; readonly participantIds: readonly string[] }[];
}

export async function recordGroupingGroups(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: RecordGroupingGroupsInput,
): Promise<CommandOutcome<StoredGroupingStage>> {
  const actor = runtimeActor(deps);
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "grouping",
    commandType: "grouping.groups.record",
    actor,
    payload: { stageId: input.stageId, expectedRevision: input.expectedRevision, groups: input.groups },
  }, async (trx) => {
    requireGroupingPermission(actor);
    const activity = await getActivityForUpdate(trx, input.activityId);
    if (activity === null) throw new DomainError("NOT_FOUND", `Activity ${input.activityId} was not found.`);
    requireNotArchived(activity);
    requireCapability(activity);
    const stage = await getGroupingStageForUpdate(trx, activity.id, input.stageId);
    if (stage === null) throw new DomainError("NOT_FOUND", "The grouping stage was not found.");
    requireRevision(stage, input.expectedRevision);
    requireDraft(stage);
    const source = await resolveGroupingSource(trx, activity.id, stage);
    const normalized = normalizeGroupingGroups(input.groups, new Set(source.participantIds), {
      complete: false,
    });
    await saveGroups(trx, stage, normalized, {
      clearExisting: true,
      reason: "",
      actorId: actor.actorId,
      leftAt: deps.now(),
      nonce: input.commandId,
    });
    const saved = { ...stage, revision: stage.revision + 1 };
    if (!(await updateGroupingStage(trx, saved, stage.revision))) {
      throw new DomainError("STALE_REVISION", "The grouping stage changed since it was read.");
    }
    await appendEngineEvent(trx, deps, {
      type: "GroupingGroupsRecorded",
      activityId: activity.id,
      aggregateType: "grouping_stage",
      aggregateId: stage.id,
      capability: "grouping",
      revision: saved.revision,
      payload: { stageId: stage.id, ...(await stageGroups(trx, saved)) },
    });
    return { body: saved };
  });
}

export interface ConfirmGroupingStageInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly stageId: string;
  readonly expectedRevision: number;
}

export async function confirmGroupingStage(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: ConfirmGroupingStageInput,
): Promise<CommandOutcome<StoredGroupingStage>> {
  const actor = runtimeActor(deps);
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "grouping",
    commandType: "grouping.stage.confirm",
    actor,
    payload: { stageId: input.stageId, expectedRevision: input.expectedRevision },
  }, async (trx) => {
    requireGroupingPermission(actor);
    const activity = await getActivityForUpdate(trx, input.activityId);
    if (activity === null) throw new DomainError("NOT_FOUND", `Activity ${input.activityId} was not found.`);
    requireNotArchived(activity);
    requireCapability(activity);
    const stage = await getGroupingStageForUpdate(trx, activity.id, input.stageId);
    if (stage === null) throw new DomainError("NOT_FOUND", "The grouping stage was not found.");
    requireRevision(stage, input.expectedRevision);
    if (stage.status !== "draft") {
      throw new DomainError("INVALID_TRANSITION", "Only a draft stage can be confirmed.");
    }
    const source = await resolveGroupingSource(trx, activity.id, stage);
    const groups = (await listGroupingGroups(trx, [stage.id])).filter((group) => group.isActive);
    const members = await listCurrentGroupingMemberships(trx, stage.id);
    const groupCount = await compiledGroupCount(trx, activity);
    normalizeGroupingGroups(
      groups.map((group) => ({
        name: group.name,
        participantIds: members
          .filter((member) => member.groupId === group.id)
          .map((member) => member.participantId),
      })),
      new Set(source.participantIds),
      { complete: true, ...(groupCount === undefined ? {} : { groupCount }) },
    );
    const saved: StoredGroupingStage = {
      ...stage,
      status: "confirmed",
      sourceFingerprint: source.fingerprint,
      confirmedAt: deps.now(),
      confirmedBy: actor.actorId,
      revision: stage.revision + 1,
    };
    if (!(await updateGroupingStage(trx, saved, stage.revision))) {
      throw new DomainError("STALE_REVISION", "The grouping stage changed since it was read.");
    }
    await appendEngineEvent(trx, deps, {
      type: "GroupingStageConfirmed",
      activityId: activity.id,
      aggregateType: "grouping_stage",
      aggregateId: stage.id,
      capability: "grouping",
      revision: saved.revision,
      payload: { stageId: stage.id, sourceFingerprint: saved.sourceFingerprint },
    });
    return { body: saved };
  });
}

export interface FreezeGroupingStageInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly stageId: string;
  readonly expectedRevision: number;
}

export async function freezeGroupingStage(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: FreezeGroupingStageInput,
): Promise<CommandOutcome<StoredGroupingStage>> {
  const actor = runtimeActor(deps);
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "grouping",
    commandType: "grouping.stage.freeze",
    actor,
    payload: { stageId: input.stageId, expectedRevision: input.expectedRevision },
  }, async (trx) => {
    requireGroupingPermission(actor);
    const activity = await getActivityForUpdate(trx, input.activityId);
    if (activity === null) throw new DomainError("NOT_FOUND", `Activity ${input.activityId} was not found.`);
    requireNotArchived(activity);
    requireCapability(activity);
    const stage = await getGroupingStageForUpdate(trx, activity.id, input.stageId);
    if (stage === null) throw new DomainError("NOT_FOUND", "The grouping stage was not found.");
    requireRevision(stage, input.expectedRevision);
    if (stage.status !== "confirmed") {
      throw new DomainError("INVALID_TRANSITION", "Only a confirmed stage can be frozen.");
    }
    const source = await resolveGroupingSource(trx, activity.id, stage);
    if (stage.sourceFingerprint !== "" && stage.sourceFingerprint !== source.fingerprint) {
      throw new DomainError("GROUPING_SOURCE_CHANGED", "The source roster changed after confirmation.");
    }
    const groups = (await listGroupingGroups(trx, [stage.id])).filter((group) => group.isActive);
    const members = await listCurrentGroupingMemberships(trx, stage.id);
    const groupCount = await compiledGroupCount(trx, activity);
    normalizeGroupingGroups(
      groups.map((group) => ({
        name: group.name,
        participantIds: members
          .filter((member) => member.groupId === group.id)
          .map((member) => member.participantId),
      })),
      new Set(source.participantIds),
      { complete: true, ...(groupCount === undefined ? {} : { groupCount }) },
    );
    const saved: StoredGroupingStage = {
      ...stage,
      status: "frozen",
      sourceFingerprint: source.fingerprint,
      frozenAt: deps.now(),
      frozenBy: actor.actorId,
      revision: stage.revision + 1,
    };
    if (!(await updateGroupingStage(trx, saved, stage.revision))) {
      throw new DomainError("STALE_REVISION", "The grouping stage changed since it was read.");
    }
    await appendEngineEvent(trx, deps, {
      type: "GroupingStageFrozen",
      activityId: activity.id,
      aggregateType: "grouping_stage",
      aggregateId: stage.id,
      capability: "grouping",
      revision: saved.revision,
      payload: { stageId: stage.id },
    });
    return { body: saved };
  });
}

export interface CorrectGroupingStageInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly stageId: string;
  readonly expectedRevision: number;
  readonly groups: readonly { readonly name?: string; readonly participantIds: readonly string[] }[];
  readonly reason: string;
}

export async function correctGroupingStage(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: CorrectGroupingStageInput,
): Promise<CommandOutcome<StoredGroupingStage>> {
  const actor = runtimeActor(deps);
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "grouping",
    commandType: "grouping.stage.correct",
    actor,
    payload: {
      stageId: input.stageId,
      expectedRevision: input.expectedRevision,
      groups: input.groups,
      reason: input.reason,
    },
  }, async (trx) => {
    requireGroupingPermission(actor);
    const reason = requireReason(input.reason);
    const activity = await getActivityForUpdate(trx, input.activityId);
    if (activity === null) throw new DomainError("NOT_FOUND", `Activity ${input.activityId} was not found.`);
    requireNotArchived(activity);
    requireCapability(activity);
    const stage = await getGroupingStageForUpdate(trx, activity.id, input.stageId);
    if (stage === null) throw new DomainError("NOT_FOUND", "The grouping stage was not found.");
    requireRevision(stage, input.expectedRevision);
    if (stage.status !== "confirmed" && stage.status !== "frozen") {
      throw new DomainError("INVALID_TRANSITION", "Only a confirmed or frozen stage can be corrected.");
    }
    const currentMembers = await listCurrentGroupingMemberships(trx, stage.id);
    const affectedParticipants = [...new Set([
      ...currentMembers.map((member) => member.participantId),
      ...input.groups.flatMap((group) => group.participantIds),
    ])];
    await requireNoConsumedGrouping(
      trx,
      activity.id,
      affectedParticipants,
      "GROUPING_CONSUMED",
      "A confirmed result names participants whose grouping would change.",
    );
    const source = await resolveGroupingSource(trx, activity.id, stage);
    const groupCount = await compiledGroupCount(trx, activity);
    const normalized = normalizeGroupingGroups(input.groups, new Set(source.participantIds), {
      complete: true,
      ...(groupCount === undefined ? {} : { groupCount }),
    });
    await saveGroups(trx, stage, normalized, {
      clearExisting: false,
      reason,
      actorId: actor.actorId,
      leftAt: deps.now(),
      nonce: input.commandId,
    });
    const saved: StoredGroupingStage = {
      ...stage,
      sourceFingerprint: source.fingerprint,
      confirmedAt: deps.now(),
      confirmedBy: actor.actorId,
      ...(stage.status === "frozen" ? { frozenAt: deps.now(), frozenBy: actor.actorId } : {}),
      revision: stage.revision + 1,
    };
    if (!(await updateGroupingStage(trx, saved, stage.revision))) {
      throw new DomainError("STALE_REVISION", "The grouping stage changed since it was read.");
    }
    await appendEngineEvent(trx, deps, {
      type: "GroupingStageCorrected",
      activityId: activity.id,
      aggregateType: "grouping_stage",
      aggregateId: stage.id,
      capability: "grouping",
      revision: saved.revision,
      payload: { stageId: stage.id, reason, groups: (await stageGroups(trx, saved)).groups },
    });
    return { body: saved };
  });
}

export interface CancelGroupingStageInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly stageId: string;
  readonly expectedRevision: number;
  readonly reason: string;
}

export async function cancelGroupingStage(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: CancelGroupingStageInput,
): Promise<CommandOutcome<StoredGroupingStage>> {
  const actor = runtimeActor(deps);
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "grouping",
    commandType: "grouping.stage.cancel",
    actor,
    payload: { stageId: input.stageId, expectedRevision: input.expectedRevision, reason: input.reason },
  }, async (trx) => {
    requireGroupingPermission(actor);
    const reason = requireReason(input.reason);
    const activity = await getActivityForUpdate(trx, input.activityId);
    if (activity === null) throw new DomainError("NOT_FOUND", `Activity ${input.activityId} was not found.`);
    requireNotArchived(activity);
    requireCapability(activity);
    const stage = await getGroupingStageForUpdate(trx, activity.id, input.stageId);
    if (stage === null) throw new DomainError("NOT_FOUND", "The grouping stage was not found.");
    requireRevision(stage, input.expectedRevision);
    if (stage.status === "cancelled") return { body: stage };
    if (stage.status === "frozen") {
      throw new DomainError("INVALID_TRANSITION", "A frozen stage cannot be cancelled.");
    }
    if (stage.status === "confirmed") {
      const members = await listCurrentGroupingMemberships(trx, stage.id);
      await requireNoConsumedGrouping(
        trx,
        activity.id,
        members.map((member) => member.participantId),
        "GROUPING_CONSUMED",
        "A confirmed result names participants whose grouping would be cancelled.",
      );
    }
    const saved: StoredGroupingStage = {
      ...stage,
      status: "cancelled",
      materialWindow: "closed",
      cancelReason: reason,
      cancelledAt: deps.now(),
      cancelledBy: actor.actorId,
      revision: stage.revision + 1,
    };
    if (!(await updateGroupingStage(trx, saved, stage.revision))) {
      throw new DomainError("STALE_REVISION", "The grouping stage changed since it was read.");
    }
    await appendEngineEvent(trx, deps, {
      type: "GroupingStageCancelled",
      activityId: activity.id,
      aggregateType: "grouping_stage",
      aggregateId: stage.id,
      capability: "grouping",
      revision: saved.revision,
      payload: { stageId: stage.id, reason },
    });
    return { body: saved };
  });
}

export interface SetGroupingWindowInput {
  readonly commandId: string;
  readonly activityId: string;
  readonly stageId: string;
  readonly expectedRevision: number;
  readonly window: GroupingMaterialWindow;
  readonly note?: string;
}

export async function setGroupingMaterialWindow(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: SetGroupingWindowInput,
): Promise<CommandOutcome<StoredGroupingStage>> {
  const actor = runtimeActor(deps);
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "grouping",
    commandType: "grouping.window.set",
    actor,
    payload: {
      stageId: input.stageId,
      expectedRevision: input.expectedRevision,
      window: input.window,
      note: input.note ?? null,
    },
  }, async (trx) => {
    requireGroupingPermission(actor);
    const activity = await getActivityForUpdate(trx, input.activityId);
    if (activity === null) throw new DomainError("NOT_FOUND", `Activity ${input.activityId} was not found.`);
    requireNotArchived(activity);
    requireCapability(activity);
    if (!WINDOWS.has(input.window)) {
      throw new DomainError("GROUPING_WINDOW_INVALID", "Unknown material window state.");
    }
    const stage = await getGroupingStageForUpdate(trx, activity.id, input.stageId);
    if (stage === null) throw new DomainError("NOT_FOUND", "The grouping stage was not found.");
    requireRevision(stage, input.expectedRevision);
    if (stage.status !== "confirmed" && stage.status !== "frozen") {
      throw new DomainError("INVALID_TRANSITION", "Only a confirmed or frozen stage has a material window.");
    }
    if (stage.materialWindow === input.window) {
      return { body: stage };
    }
    const saved: StoredGroupingStage = {
      ...stage,
      materialWindow: input.window,
      revision: stage.revision + 1,
    };
    if (!(await updateGroupingStage(trx, saved, stage.revision))) {
      throw new DomainError("STALE_REVISION", "The grouping stage changed since it was read.");
    }
    await appendEngineEvent(trx, deps, {
      type: "GroupingMaterialWindowChanged",
      activityId: activity.id,
      aggregateType: "grouping_stage",
      aggregateId: stage.id,
      capability: "grouping",
      revision: saved.revision,
      payload: { stageId: stage.id, window: input.window, note: input.note ?? "" },
    });
    return { body: saved };
  });
}
