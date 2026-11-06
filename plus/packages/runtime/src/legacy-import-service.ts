import type { Database, StoredRound } from "@artflow-plus/db";
import {
  insertDraft,
  insertJudgeSeat,
  insertMaterial,
  insertMaterialCheck,
  insertPanelMember,
  insertPanelSnapshot,
  insertPerformance,
  insertRankingSnapshot,
  insertRegistration,
  insertRelease,
  insertResultPublication,
  insertResultRelease,
  insertRound,
  insertScoreFact,
  insertStageResult,
  insertVoteOptions,
  insertVoteSession,
  updateActivity,
  updateRound,
  upsertRoster,
} from "@artflow-plus/db";
import {
  buildAdoptionDefinition,
  computeRanking,
  decimalValue,
  DomainError,
  releaseDefinition,
  RUNTIME_CONTRACT_VERSION,
} from "@artflow-plus/domain";
import type {
  Activity,
  ActivityPack,
  CapabilityRegistry,
  CompiledActivityDefinition,
  DefinitionDraft,
  ExecutionPolicy,
  ResultAward,
  ResultDecision,
  ResultSnapshot,
} from "@artflow-plus/domain";
import type { Kysely, Transaction } from "kysely";

import { executeCommand } from "./command.js";
import { runtimeActor, type RuntimeDeps } from "./deps.js";
import { appendEngineEvent } from "./events.js";
import { idFromCommand, stableHash } from "./hash.js";
import {
  parseLegacyBundle,
  type LegacyBundle,
  type LegacyCounts,
  type LegacyExcluded,
} from "./legacy-bundle.js";

const LEGACY_CAPABILITIES = ["registration", "questionnaire", "materials", "competition"] as const;

export interface ImportLegacyInput {
  readonly commandId: string;
  readonly bundle: unknown;
  readonly dryRun: boolean;
}

export interface LegacyImportCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly expected: number | string;
  readonly actual: number | string;
}

export type LegacyImportMode = "historical" | "adoption";

export interface LegacyAdoptionOptions {
  readonly registry: CapabilityRegistry;
  readonly pack: ActivityPack;
  readonly answers?: Readonly<Record<string, boolean>>;
  readonly enable?: readonly string[];
  readonly disable?: readonly string[];
}

export interface LegacyImportReport {
  readonly mode: LegacyImportMode;
  readonly publicCode: string;
  readonly activityId: string;
  readonly bundleHash: string;
  readonly dryRun: boolean;
  readonly imported: LegacyCounts;
  readonly excluded: LegacyExcluded;
  readonly unsupported: LegacyBundle["unsupported"];
  readonly checks: readonly LegacyImportCheck[];
  /** Adoption only: the real Plus composition, release and readiness. */
  readonly capabilities?: readonly string[];
  readonly definitionVersion?: number;
  readonly releaseHash?: string;
  readonly semanticReady?: boolean;
  readonly warnings?: readonly string[];
}

export interface LegacyImportResult {
  readonly report: LegacyImportReport;
}

function check(name: string, actual: number | string, expected: number | string): LegacyImportCheck {
  return { name, ok: String(actual) === String(expected), actual, expected };
}

function activityIdFor(publicCode: string): string {
  return `legacy-act-${publicCode}`;
}

function questionnaireArtifact(bundle: LegacyBundle) {
  const questions = bundle.questionnaire.questions.map((question) => ({
    key: question.key,
    label: question.label,
    type: question.type,
    required: question.required,
  }));
  return {
    schemaVersion: 1 as const,
    version: bundle.questionnaire.version,
    schemaHash: stableHash({ version: bundle.questionnaire.version, questions }),
    questions,
    fileSlots: [],
  };
}

function competitionArtifact(bundle: LegacyBundle) {
  const roundKeys = bundle.rounds.map((round) => round.key);
  return {
    order: ["roster", ...roundKeys, "result"],
    nodes: [
      { key: "roster", type: "roster" },
      ...roundKeys.map((key) => ({ key, type: "round" })),
      { key: "result", type: "output" },
    ],
    edges: [
      { from: "roster", to: roundKeys[0] ?? "result" },
      ...roundKeys.slice(1).map((key, index) => ({ from: roundKeys[index], to: key })),
      { from: roundKeys[roundKeys.length - 1] ?? "roster", to: "result" },
    ],
    rounds: bundle.rounds.map((round) => ({
      key: round.key,
      judgeCount: round.judgeCount,
      minimumJudges: round.minimumJudges,
      completion: round.completion,
      advanceCount: round.advanceCount,
      scoringMethod: round.scoringMethod,
    })),
    rubric: { criteria: bundle.rubric.criteria },
    tiePolicy: bundle.rubric.tiePolicy,
  };
}

function plans(bundle: LegacyBundle) {
  const questionnaire = questionnaireArtifact(bundle);
  const competition = competitionArtifact(bundle);
  return {
    questionnaire,
    competition,
    contentHashes: {
      questionnaire: stableHash(questionnaire),
      competition: stableHash(competition),
    },
    capabilityPlan: (key: string, artifact: unknown, contentHash: string) => ({
      ok: true as const,
      capabilityKey: key,
      contentHash,
      artifact,
    }),
  };
}

interface AdoptionPlan {
  readonly capabilities: readonly string[];
  readonly definition: DefinitionDraft["package"];
  readonly compiled: CompiledActivityDefinition;
  readonly executionPolicy: ExecutionPolicy;
  readonly capabilityVersions: Readonly<Record<string, string>>;
  readonly bindings: DefinitionDraft["package"]["bindings"];
  readonly warnings: readonly string[];
  readonly checks: readonly LegacyImportCheck[];
  readonly semanticReady: boolean;
}

const ADOPTION_BLOCKING_UNSUPPORTED = new Set(["multiple_rubrics", "group_material"]);

function registrationLifecycle(bundle: LegacyBundle): "draft" | "open" | "review" | "final" {
  if (bundle.roster.status === "final") return "final";
  return bundle.registrations.length > 0 ? "review" : "open";
}

function buildAdoptionPlan(
  bundle: LegacyBundle,
  options: LegacyAdoptionOptions,
): AdoptionPlan {
  const blockingUnsupported = bundle.unsupported.filter((item) =>
    ADOPTION_BLOCKING_UNSUPPORTED.has(item.kind),
  );
  if (blockingUnsupported.length > 0) {
    throw new DomainError(
      "LEGACY_BUNDLE_INVALID",
      `Adoption cannot represent: ${blockingUnsupported.map((item) => item.kind).join(", ")}.`,
    );
  }
  const grouping = bundle.grouping;
  const adopted = buildAdoptionDefinition({
    pack: options.pack,
    registry: options.registry,
    facts: {
      title: bundle.activity.title,
      questionnaire: bundle.questionnaire,
      rounds: bundle.rounds.map((round) => ({
        key: round.key,
        judgeCount: round.judgeCount,
        minimumJudges: round.minimumJudges,
        completion: round.completion,
        scoringMethod: round.scoringMethod,
        advanceCount: round.advanceCount,
      })),
      rubric: bundle.rubric,
      ...(grouping === undefined || grouping.length === 0
        ? {}
        : {
            grouping: {
              stageCount: grouping.length,
              groupCount: grouping.length === 1 ? grouping[0]!.groups.length : undefined,
            },
          }),
      registrationLifecycle: registrationLifecycle(bundle),
      hasRegistrations: bundle.registrations.length > 0,
      hasMaterials: bundle.materials.length > 0 || (bundle.materialChecks?.length ?? 0) > 0,
      materialContentTypes: bundle.materials.map((material) => material.contentType),
      materialChecks: (bundle.materialChecks ?? []).map((check) => ({
        key: check.questionKey,
        label: check.itemName,
        required: check.required,
        purposes: check.acceptedFilePurposes.length > 0
          ? check.acceptedFilePurposes
          : check.filePurpose === ""
            ? []
            : [check.filePurpose],
      })),
    },
    ...(options.answers === undefined ? {} : { answers: options.answers }),
    ...(options.enable === undefined ? {} : { enable: options.enable }),
    ...(options.disable === undefined ? {} : { disable: options.disable }),
  });
  if (!adopted.ok) {
    throw new DomainError(
      "LEGACY_BUNDLE_INVALID",
      `The adoption definition is not compatible: ${adopted.issues.map((item) => `${item.code} ${item.path}`).join(", ")}.`,
    );
  }
  const capabilityVersions: Record<string, string> = {};
  for (const identity of adopted.capabilities) {
    const registration = options.registry.get(identity);
    if (registration !== undefined) capabilityVersions[identity] = registration.manifest.version;
  }
  const warnings: string[] = [...adopted.warnings];
  if (bundle.competition.scores.length > 0) {
    warnings.push("Legacy scores stay in v1; adoption imports preparation facts only.");
  }
  if (bundle.voting.ballots.length > 0) {
    warnings.push("Legacy ballots stay in v1; open fresh voting sessions in Plus.");
  }
  if (bundle.results.releases.length > 0) {
    warnings.push("Legacy published results stay in v1; this adoption has no active result.");
  }
  for (const unsupported of bundle.unsupported) {
    if (!ADOPTION_BLOCKING_UNSUPPORTED.has(unsupported.kind)) {
      warnings.push(`Unsupported ${unsupported.kind} stays in v1: ${unsupported.reason}`);
    }
  }

  const questionnaireArtifact = adopted.compiled.capabilities.questionnaire?.artifact as
    | { version?: string; schemaHash?: string; questions?: readonly { key: string }[] }
    | undefined;
  const competitionArtifact = adopted.compiled.capabilities.competition?.artifact as
    | {
        rounds?: readonly { key: string; judgeCount: number; minimumJudges: number }[];
        rubric?: { criteria: readonly unknown[] };
      }
    | undefined;
  const groupingArtifact = adopted.compiled.capabilities.grouping?.artifact as
    | { groupCount?: number | null }
    | undefined;
  const registrationArtifact = adopted.compiled.capabilities.registration?.artifact as
    | { lifecycle?: string }
    | undefined;
  const publishingArtifact = adopted.compiled.capabilities.publishing?.artifact as
    | { stages?: readonly { key: string }[] }
    | undefined;

  const checks: LegacyImportCheck[] = [];
  const questionnaireKeys = (questionnaireArtifact?.questions ?? []).map((question) => question.key).sort();
  checks.push(check(
    "adoption.questionnaire",
    questionnaireKeys.join(","),
    [...bundle.questionnaire.questions.map((question) => question.key),
      ...(bundle.materialChecks ?? []).map((check) => check.questionKey)].sort().join(","),
  ));
  const roundKeys = (competitionArtifact?.rounds ?? []).map((round) => round.key).sort();
  checks.push(check(
    "adoption.roundKeys",
    roundKeys.join(","),
    bundle.rounds.map((round) => round.key).sort().join(","),
  ));
  const judgeSignature = (rounds: readonly { key: string; judgeCount: number; minimumJudges: number }[]) =>
    [...rounds].sort((left, right) => left.key.localeCompare(right.key))
      .map((round) => `${round.key}:${round.judgeCount}/${round.minimumJudges}`).join(",");
  checks.push(check(
    "adoption.judgeConfig",
    judgeSignature(competitionArtifact?.rounds ?? []),
    judgeSignature(bundle.rounds),
  ));
  checks.push(check(
    "adoption.rubric",
    stableHash(competitionArtifact?.rubric ?? {}),
    stableHash({ criteria: bundle.rubric.criteria }),
  ));
  checks.push(check(
    "adoption.registrationLifecycle",
    registrationArtifact?.lifecycle ?? "missing",
    registrationLifecycle(bundle),
  ));
  if (grouping !== undefined && grouping.length === 1) {
    checks.push(check(
      "adoption.groupCount",
      groupingArtifact?.groupCount ?? "unconstrained",
      grouping[0]!.groups.length,
    ));
  }
  const materialQuestionKeys = new Set(questionnaireKeys);
  const missingSlots = bundle.materials
    .map((material) => material.questionKey)
    .filter((key) => !materialQuestionKeys.has(key));
  checks.push(check("adoption.materialSlots", missingSlots.join(","), ""));
  if (publishingArtifact !== undefined) {
    const stages = (publishingArtifact.stages ?? []).length;
    checks.push(check("adoption.publishingStages", stages > 0 ? 1 : 0, 1));
  }
  const semanticReady = checks.every((item) => item.ok);

  return {
    capabilities: adopted.capabilities,
    definition: adopted.definition,
    compiled: adopted.compiled,
    executionPolicy: {
      declaredScopes: adopted.composition.declaredScopes,
      conflicts: adopted.composition.scopeConflicts,
      runtimeContractVersion: RUNTIME_CONTRACT_VERSION,
      commandScopes: adopted.composition.commandScopes,
    },
    capabilityVersions,
    bindings: adopted.definition.bindings,
    warnings,
    checks,
    semanticReady,
  };
}

function plannedCounts(bundle: LegacyBundle): LegacyCounts {
  return {
    registrations: bundle.registrations.length,
    approvedRegistrations: bundle.registrations.filter((row) => row.status === "approved").length,
    materials: bundle.materials.length,
    materialChecks: bundle.materialChecks?.length ?? 0,
    rounds: bundle.rounds.length,
    scores: bundle.competition.scores.length,
    ballots: bundle.voting.ballots.length,
    releases: bundle.results.releases.length,
  };
}

function declaredChecks(bundle: LegacyBundle): LegacyImportCheck[] {
  const planned = plannedCounts(bundle);
  return (Object.keys(planned) as (keyof LegacyCounts)[]).map((key) =>
    check(`planned.${key}`, planned[key] ?? 0, bundle.counts[key] ?? 0),
  );
}

function requireNoUnsupported(reportUnsupported: LegacyBundle["unsupported"]): void {
  // Unsupported constructs are reported, not fatal: their facts stay in v1.
  void reportUnsupported;
}

async function countImported(
  trx: Transaction<Database>,
  activityId: string,
): Promise<LegacyCounts> {
  const registrations = await trx.selectFrom("registration")
    .select(({ fn }) => fn.countAll<number>().as("count"))
    .where("activity_id", "=", activityId)
    .executeTakeFirstOrThrow();
  const approved = await trx.selectFrom("registration")
    .select(({ fn }) => fn.countAll<number>().as("count"))
    .where("activity_id", "=", activityId)
    .where("status", "=", "approved")
    .executeTakeFirstOrThrow();
  const materials = await trx.selectFrom("material")
    .select(({ fn }) => fn.countAll<number>().as("count"))
    .where("activity_id", "=", activityId)
    .executeTakeFirstOrThrow();
  const materialChecks = await trx.selectFrom("material_check")
    .select(({ fn }) => fn.countAll<number>().as("count"))
    .where("activity_id", "=", activityId)
    .executeTakeFirstOrThrow();
  const rounds = await trx.selectFrom("competition_round")
    .select(({ fn }) => fn.countAll<number>().as("count"))
    .where("activity_id", "=", activityId)
    .executeTakeFirstOrThrow();
  const scores = await trx.selectFrom("score_fact")
    .select(({ fn }) => fn.countAll<number>().as("count"))
    .where("activity_id", "=", activityId)
    .executeTakeFirstOrThrow();
  const ballots = await trx.selectFrom("ballot")
    .select(({ fn }) => fn.countAll<number>().as("count"))
    .where("activity_id", "=", activityId)
    .executeTakeFirstOrThrow();
  const releases = await trx.selectFrom("result_release")
    .select(({ fn }) => fn.countAll<number>().as("count"))
    .where("activity_id", "=", activityId)
    .executeTakeFirstOrThrow();
  return {
    registrations: Number(registrations.count),
    approvedRegistrations: Number(approved.count),
    materials: Number(materials.count),
    materialChecks: Number(materialChecks.count),
    rounds: Number(rounds.count),
    scores: Number(scores.count),
    ballots: Number(ballots.count),
    releases: Number(releases.count),
  };
}

interface RoundPanel {
  readonly id: string;
  readonly members: readonly { readonly judgeId: string; readonly seatKey: string }[];
  readonly seatsByJudge: ReadonlyMap<string, string>;
}

async function importCompetition(
  trx: Transaction<Database>,
  bundle: LegacyBundle,
  activityId: string,
  prefix: string,
  roundsByLegacy: Map<number, StoredRound>,
): Promise<void> {
  const panelsByRound = new Map<number, RoundPanel>();
  const seatIds = new Map<string, string>();
  for (const seat of bundle.competition.seats) {
    seatIds.set(`${seat.panelLegacyId}:${seat.judgeId}`, `${prefix}-seat-${seat.legacyId}`);
  }

  const createPanel = async (
    round: StoredRound,
    roundLegacyId: number,
    panelLegacyId: number,
    panelId: string,
    members: readonly { readonly judgeId: string; readonly seatKey: string }[],
    version: number,
    current: boolean,
  ): Promise<RoundPanel> => {
    const expectedJudges = Math.max(members.length, round.minimumJudges, 1);
    await insertPanelSnapshot(trx, {
      id: panelId,
      activityId,
      roundId: round.id,
      version,
      state: current ? "active" : "superseded",
      expectedJudges,
      minimumJudges: Math.min(round.minimumJudges, expectedJudges),
      rosterDigest: stableHash({ round: round.id, members }),
      contextVersion: 1,
      current,
    });
    const seatsByJudge = new Map<string, string>();
    for (const member of members) {
      await insertPanelMember(trx, { panelId, judgeId: member.judgeId, seatKey: member.seatKey });
      const seatId = seatIds.get(`${panelLegacyId}:${member.judgeId}`) ??
        `${prefix}-seat-${panelId}-${member.seatKey}`;
      await insertJudgeSeat(trx, {
        id: seatId,
        panelId,
        judgeId: member.judgeId,
        state: "assigned",
        revision: 0,
      });
      seatsByJudge.set(member.judgeId, seatId);
    }
    if (current) {
      const updated = await updateRound(trx, { ...round, currentPanelId: panelId }, round.revision);
      roundsByLegacy.set(roundLegacyId, updated);
    }
    return { id: panelId, members, seatsByJudge };
  };

  const panelsByLegacyRound = new Map<number, typeof bundle.competition.panels[number][]>();
  for (const panel of bundle.competition.panels) {
    const group = panelsByLegacyRound.get(panel.roundLegacyId) ?? [];
    group.push(panel);
    panelsByLegacyRound.set(panel.roundLegacyId, group);
  }
  for (const [roundLegacyId, panels] of panelsByLegacyRound) {
    const round = roundsByLegacy.get(roundLegacyId);
    if (round === undefined) {
      throw new DomainError("LEGACY_BUNDLE_INVALID", "A panel references an unknown round.");
    }
    for (const [index, panel] of panels.entries()) {
      const isLast = index === panels.length - 1;
      const created = await createPanel(
        round,
        roundLegacyId,
        panel.legacyId,
        `${prefix}-panel-${panel.legacyId}`,
        panel.members,
        index + 1,
        isLast,
      );
      if (isLast) panelsByRound.set(roundLegacyId, created);
    }
  }

  for (const round of bundle.rounds) {
    const stored = roundsByLegacy.get(round.legacyId);
    if (stored === undefined) continue;
    if (panelsByRound.has(round.legacyId)) continue;
    const judgeIds = [...new Set(
      bundle.competition.scores
        .filter((score) => score.roundLegacyId === round.legacyId)
        .map((score) => score.judgeId),
    )].sort();
    if (judgeIds.length === 0) continue;
    const members = judgeIds.map((judgeId, index) => ({ judgeId, seatKey: `seat-${index + 1}` }));
    panelsByRound.set(
      round.legacyId,
      await createPanel(
        stored,
        round.legacyId,
        -1,
        `${prefix}-panel-synth-${round.legacyId}`,
        members,
        1,
        true,
      ),
    );
  }

  const performancesByKey = new Map<string, string>();
  for (const performance of bundle.competition.performances) {
    const round = roundsByLegacy.get(performance.roundLegacyId);
    if (round === undefined) throw new DomainError("LEGACY_BUNDLE_INVALID", "A performance references an unknown round.");
    const id = `${prefix}-performance-${performance.legacyId}`;
    await insertPerformance(trx, {
      id,
      activityId,
      roundId: round.id,
      contestantId: performance.contestantKey,
      sequence: performance.sequence,
      state: performance.state,
      contextVersion: 1,
    });
    performancesByKey.set(`${performance.roundLegacyId}:${performance.contestantKey}`, id);
  }

  const contestantOrder = new Map<number, string[]>();
  for (const score of bundle.competition.scores) {
    const list = contestantOrder.get(score.roundLegacyId) ?? [];
    if (!list.includes(score.contestantKey)) list.push(score.contestantKey);
    contestantOrder.set(score.roundLegacyId, list);
  }
  for (const [roundLegacyId, contestants] of contestantOrder) {
    const round = roundsByLegacy.get(roundLegacyId);
    if (round === undefined) continue;
    for (const [index, contestantKey] of contestants.entries()) {
      const key = `${roundLegacyId}:${contestantKey}`;
      if (performancesByKey.has(key)) continue;
      const id = `${prefix}-performance-synth-${roundLegacyId}-${index + 1}`;
      await insertPerformance(trx, {
        id,
        activityId,
        roundId: round.id,
        contestantId: contestantKey,
        sequence: index + 1,
        state: "locked",
        contextVersion: 1,
      });
      performancesByKey.set(key, id);
    }
  }

  for (const score of bundle.competition.scores) {
    const round = roundsByLegacy.get(score.roundLegacyId);
    const panel = panelsByRound.get(score.roundLegacyId);
    const performanceId = performancesByKey.get(`${score.roundLegacyId}:${score.contestantKey}`);
    const seatId = panel?.seatsByJudge.get(score.judgeId);
    if (round === undefined || panel === undefined || performanceId === undefined || seatId === undefined) {
      throw new DomainError("LEGACY_BUNDLE_INVALID", "A score cannot be bound to a round, panel, performance, or seat.");
    }
    await insertScoreFact(trx, {
      id: `${prefix}-score-${score.legacyId}`,
      activityId,
      roundId: round.id,
      performanceId,
      contestantId: score.contestantKey,
      judgeId: score.judgeId,
      panelSnapshotId: panel.id,
      seatId,
      source: score.source,
      mode: "formal",
      total: score.total,
      criteria: score.criteria,
      notes: score.notes,
      version: 1,
      contextVersion: 1,
      current: true,
    });
  }

  const rankedRounds = new Set(bundle.competition.rankings.map((ranking) => ranking.roundLegacyId));
  for (const ranking of bundle.competition.rankings) {
    const round = roundsByLegacy.get(ranking.roundLegacyId);
    if (round === undefined) continue;
    await insertRankingSnapshot(trx, {
      id: `${prefix}-ranking-${round.id}`,
      activityId,
      roundId: round.id,
      mode: "formal",
      sourceScoreVersion: round.scoreVersion,
      inputFingerprint: ranking.inputFingerprint,
      status: ranking.tieGroups.length > 0 ? "hold" : "ready",
      rows: ranking.rows,
      tieGroups: ranking.tieGroups,
      revision: 1,
    });
  }

  // Bundles without a frozen v1 ranking still get one derived from the imported
  // facts, so the historical round is explainable in v2.
  for (const [roundLegacyId, contestants] of contestantOrder) {
    if (rankedRounds.has(roundLegacyId)) continue;
    const round = roundsByLegacy.get(roundLegacyId);
    if (round === undefined) continue;
    const rows = contestants.map((contestantKey) => {
      const totals = bundle.competition.scores
        .filter((score) => score.roundLegacyId === roundLegacyId && score.contestantKey === contestantKey)
        .map((score) => Number(score.total));
      const sorted = [...totals].sort((left, right) => left - right);
      const effective = round.scoringMethod === "drop_high_low" && sorted.length >= 3
        ? sorted.slice(1, -1)
        : sorted;
      const sum = effective.reduce((total, value) => total + value, 0);
      return {
        contestantId: contestantKey,
        total: decimalValue(sum / effective.length),
        judgeCount: totals.length,
      };
    });
    const ranking = computeRanking({ rows, tiePolicy: "review" });
    await insertRankingSnapshot(trx, {
      id: `${prefix}-ranking-${round.id}`,
      activityId,
      roundId: round.id,
      mode: "formal",
      sourceScoreVersion: round.scoreVersion,
      inputFingerprint: stableHash({ round: round.id, rows }),
      status: ranking.status,
      rows: ranking.rows,
      tieGroups: ranking.tieGroups,
      revision: 1,
    });
  }
}

async function importVoting(
  trx: Transaction<Database>,
  bundle: LegacyBundle,
  activityId: string,
  prefix: string,
): Promise<void> {
  const sessionIds = new Map<number, string>();
  const optionIds = new Set<number>();
  for (const session of bundle.voting.sessions) {
    if (!["popularity", "score_component"].includes(session.purpose)) {
      throw new DomainError("LEGACY_BUNDLE_INVALID", `Unknown vote purpose ${session.purpose}.`);
    }
    const id = `${prefix}-vote-${session.legacyId}`;
    sessionIds.set(session.legacyId, id);
    await insertVoteSession(trx, {
      id,
      activityId,
      definitionVersion: 1,
      mode: "formal",
      purpose: session.purpose,
      selectionType: session.selectionType,
      maxSelections: session.maxSelections,
      identityPolicy: session.identityPolicy,
      scoringRule: session.scoringRule as never,
      status: session.status,
      revision: 0,
      ...(session.openedAt === null ? {} : { openedAt: session.openedAt }),
      ...(session.closedAt === null ? {} : { closedAt: session.closedAt }),
    });
    await insertVoteOptions(trx, session.options.map((option, ordinal) => {
      optionIds.add(option.legacyId);
      return {
        id: `${prefix}-option-${option.legacyId}`,
        activityId,
        sessionId: id,
        candidateId: option.candidateKey,
        ordinal,
      };
    }));
  }

  for (const ballot of bundle.voting.ballots) {
    const sessionId = sessionIds.get(ballot.sessionLegacyId);
    if (sessionId === undefined) {
      throw new DomainError("LEGACY_BUNDLE_INVALID", "A ballot references an unknown session.");
    }
    const ballotId = `${prefix}-ballot-${ballot.legacyId}`;
    await trx.insertInto("ballot").values({
      id: ballotId,
      activity_id: activityId,
      session_id: sessionId,
      identity_type: "anonymous",
      identity_digest: null,
      ticket_id: null,
      submitted_at: ballot.submittedAt,
    }).execute();
    for (const optionLegacyId of ballot.optionLegacyIds) {
      if (!optionIds.has(optionLegacyId)) {
        throw new DomainError("LEGACY_BUNDLE_INVALID", "A ballot references an unknown option.");
      }
      await trx.insertInto("vote_record").values({
        id: `${prefix}-record-${ballot.legacyId}-${optionLegacyId}`,
        activity_id: activityId,
        session_id: sessionId,
        ballot_id: ballotId,
        option_id: `${prefix}-option-${optionLegacyId}`,
      }).execute();
    }
  }
}

function stageToken(stageKey: string): string {
  return stableHash(stageKey).slice(0, 16);
}

/**
 * v1 snapshots are snake_case (`activity_title`, `contestant_id`); v2's public
 * selector only accepts camelCase. Normalize both shapes so hand fixtures and
 * real exports agree.
 */
function normalizeResultSnapshot(
  value: unknown,
  stageKey: string,
  fallbackTitle: string,
): ResultSnapshot {
  const raw = value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const pick = (camel: string, snake: string): unknown => raw[camel] ?? raw[snake];
  const decisionsRaw = Array.isArray(raw.decisions) ? raw.decisions as Record<string, unknown>[] : [];
  const awardsRaw = Array.isArray(raw.awards) ? raw.awards as Record<string, unknown>[] : [];
  return {
    activityTitle: String(pick("activityTitle", "activity_title") ?? fallbackTitle),
    publicTitle: String(pick("publicTitle", "public_title") ?? `${fallbackTitle} · 正式赛果`),
    stageKey: String(pick("stageKey", "stage_key") ?? stageKey),
    decisions: decisionsRaw
      .filter((decision) => decision.rank !== undefined)
      .map((decision) => ({
        rank: Number(decision.rank),
        contestantId: String(decision.contestantId ?? decision.contestant_id ?? decision.contestant ?? ""),
        score: decision.score === undefined || decision.score === null ? "0.00" : String(decision.score),
      })),
    awards: awardsRaw.map((award) => ({
      award: String(award.award ?? award.name ?? ""),
      contestantId: String(award.contestantId ?? award.contestant_id ?? award.contestant ?? ""),
    })),
  };
}

async function importResults(
  trx: Transaction<Database>,
  bundle: LegacyBundle,
  activityId: string,
  bundleHash: string,
  prefix: string,
): Promise<void> {
  const stageIds = new Map<string, string>();
  const latestStageByKey = new Map(bundle.results.stageResults.map((stage) => [stage.stageKey, stage]));
  for (const stage of latestStageByKey.values()) {
    const id = `${prefix}-stage-${stageToken(stage.stageKey)}`;
    stageIds.set(stage.stageKey, id);
    await insertStageResult(trx, {
      id,
      activityId,
      stageKey: stage.stageKey,
      status: "confirmed",
      candidateRevision: 1,
      sourceCandidateRevision: 1,
      inputFingerprint: bundleHash,
      source: {
        kind: "legacy_import",
        aggregateId: id,
        definitionVersion: 1,
        releaseHash: bundleHash,
        mode: "formal",
        sourceRevision: 1,
        inputFingerprint: bundleHash,
        dependencyIds: [],
        dependencyRefs: [],
      },
      decisions: stage.decisions as unknown as readonly ResultDecision[],
      awards: stage.awards as unknown as readonly ResultAward[],
      note: "",
      revision: 1,
      confirmedAt: stage.confirmedAt,
      staleReason: "",
    });
  }

  const publications = new Set<string>();
  for (const [index, release] of bundle.results.releases.entries()) {
    const snapshot = normalizeResultSnapshot(release.snapshot, release.stageKey, bundle.activity.title);
    let stageId = stageIds.get(release.stageKey);
    if (stageId === undefined) {
      stageId = `${prefix}-stage-${stageToken(release.stageKey)}`;
      stageIds.set(release.stageKey, stageId);
      await insertStageResult(trx, {
        id: stageId,
        activityId,
        stageKey: release.stageKey,
        status: "confirmed",
        candidateRevision: 1,
        sourceCandidateRevision: 1,
        inputFingerprint: bundleHash,
        source: {
          kind: "legacy_import",
          aggregateId: stageId,
          definitionVersion: 1,
          releaseHash: bundleHash,
          mode: "formal",
          sourceRevision: 1,
          inputFingerprint: bundleHash,
          dependencyIds: [],
          dependencyRefs: [],
        },
        decisions: (snapshot.decisions ?? []) as readonly ResultDecision[],
        awards: (snapshot.awards ?? []) as readonly ResultAward[],
        note: release.note,
        revision: 1,
        confirmedAt: release.releasedAt,
        staleReason: "",
      });
    }
    const publicationId = `${prefix}-pub-${stageToken(release.stageKey)}`;
    if (!publications.has(publicationId)) {
      publications.add(publicationId);
      await insertResultPublication(trx, {
        id: publicationId,
        activityId,
        stageKey: release.stageKey,
        title: String(snapshot.publicTitle ?? release.stageKey),
        content: "",
        version: 1,
        revision: 0,
      });
    }
    await insertResultRelease(trx, {
      id: `${prefix}-release-${stageToken(release.stageKey)}-${index + 1}`,
      activityId,
      publicationId,
      stageResultId: stageId,
      stageKey: release.stageKey,
      status: release.status,
      snapshot,
      snapshotCandidateRevision: 1,
      resultVersion: release.resultVersion,
      postVersion: release.postVersion,
      inputFingerprint: bundleHash,
      note: release.note,
      releasedAt: release.releasedAt,
      ...(release.status === "revoked" ? { revokedAt: release.releasedAt } : {}),
      ...(release.status === "superseded" ? { supersededAt: release.releasedAt } : {}),
      revision: 0,
    });
  }
}

async function importGrouping(
  trx: Transaction<Database>,
  activityId: string,
  publicCode: string,
  prefix: string,
  stages: NonNullable<LegacyBundle["grouping"]>,
  participantKeys: ReadonlySet<string>,
  roundIdByLegacy: ReadonlyMap<number, string>,
  createdAt: string,
  notes: string[],
): Promise<void> {
  const stageIdFor = (legacyId: number) => `legacy-${publicCode}-grouping-${legacyId}`;
  const groupIdFor = (legacyId: number) => `legacy-${publicCode}-grouping-group-${legacyId}`;
  for (const stage of stages) {
    const sourceRoundId =
      stage.sourceRoundLegacyId === undefined || stage.sourceRoundLegacyId === null
        ? undefined
        : roundIdByLegacy.get(stage.sourceRoundLegacyId);
    const rosterSource =
      stage.rosterSource === "round_advanced" && sourceRoundId !== undefined
        ? "round_advanced"
        : "all_approved";
    if (stage.rosterSource === "round_advanced" && rosterSource === "all_approved") {
      notes.push(
        `grouping ${stage.stageKey}: source round ${stage.sourceRoundLegacyId ?? "?"} was not imported; treated as all_approved`,
      );
    }
    const stageId = stageIdFor(stage.legacyId);
    await trx.insertInto("grouping_stage").values({
      id: stageId,
      activity_id: activityId,
      stage_key: stage.stageKey,
      name: stage.name,
      status: stage.status,
      roster_source: rosterSource,
      source_round_id: rosterSource === "round_advanced" ? sourceRoundId ?? null : null,
      source_fingerprint: "",
      material_window: stage.materialWindow,
      cancel_reason: "",
      confirmed_at: stage.status === "draft" ? null : createdAt,
      confirmed_by: stage.status === "draft" ? null : "legacy",
      frozen_at: stage.status === "frozen" ? createdAt : null,
      frozen_by: stage.status === "frozen" ? "legacy" : null,
      cancelled_at: stage.status === "cancelled" ? createdAt : null,
      cancelled_by: stage.status === "cancelled" ? "legacy" : null,
      revision: 1,
      created_at: new Date(createdAt),
      updated_at: createdAt,
    }).execute();

    for (const group of stage.groups) {
      const groupId = groupIdFor(group.legacyId);
      await trx.insertInto("grouping_group").values({
        id: groupId,
        stage_id: stageId,
        group_order: group.groupOrder,
        name: group.name,
        is_active: true,
        created_at: new Date(createdAt),
        updated_at: createdAt,
      }).execute();
      for (const participantKey of group.participantKeys) {
        if (!participantKeys.has(participantKey)) {
          notes.push(
            `grouping ${stage.stageKey}: participant ${participantKey} has no imported registration`,
          );
          continue;
        }
        await trx.insertInto("grouping_membership").values({
          id: `legacy-${publicCode}-grouping-member-${group.legacyId}-${participantKey}`,
          stage_id: stageId,
          group_id: groupId,
          participant_id: participantKey,
          is_current: true,
          joined_at: createdAt,
          left_at: null,
          removed_by: null,
          reason: "",
        }).execute();
      }
    }
  }
}

async function importActivity(
  trx: Transaction<Database>,
  bundle: LegacyBundle,
  activityId: string,
  bundleHash: string,
  deps: RuntimeDeps,
  adoption?: AdoptionPlan,
): Promise<LegacyImportReport> {
  const existing = await trx.selectFrom("activity").select("id")
    .where("public_code", "=", bundle.activity.publicCode)
    .executeTakeFirst();
  if (existing !== undefined) {
    throw new DomainError("LEGACY_ACTIVITY_EXISTS", "An activity with this public code already exists.");
  }
  if (adoption !== undefined && bundle.results.releases.some((release) => release.status === "active")) {
    throw new DomainError(
      "LEGACY_BUNDLE_INVALID",
      "Adoption requires a current activity without an active published result.",
    );
  }
  const artifacts = plans(bundle);
  const hasGrouping = bundle.grouping !== undefined && bundle.grouping.length > 0;
  const enabledCapabilities = adoption?.capabilities ?? (hasGrouping
    ? [...LEGACY_CAPABILITIES, "grouping"]
    : [...LEGACY_CAPABILITIES]);
  // Historical imports are durable snapshots, not an alternate bootstrap path.
  // They must remain closed even when the legacy export has no active result;
  // operational adoption is the only mode that creates an active activity.
  const status = adoption !== undefined ? "active" : "closed";
  await trx.insertInto("activity").values({
    id: activityId,
    public_code: bundle.activity.publicCode,
    title: bundle.activity.title,
    status,
    revision: 1,
    enabled_capabilities: JSON.stringify(enabledCapabilities),
    active_definition_version: adoption === undefined ? 1 : 0,
  }).execute();

  if (adoption !== undefined) {
    const draft: DefinitionDraft = {
      activityId,
      revision: 0,
      status: "draft",
      package: adoption.definition,
    };
    const baseActivity: Activity = {
      id: activityId,
      title: bundle.activity.title,
      status: "active",
      revision: 1,
      enabledCapabilities,
      activeDefinitionVersion: 0,
    };
    const released = releaseDefinition({
      activity: baseActivity,
      draft,
      expectedDraftRevision: 0,
      compiled: adoption.compiled,
      releasedAt: bundle.exportedAt,
      executionPolicy: adoption.executionPolicy,
      capabilityVersions: adoption.capabilityVersions,
      bindings: adoption.bindings ?? [],
    });
    await insertDraft(trx, { activityId, revision: 0, package: adoption.definition });
    await insertRelease(trx, {
      activityId,
      version: released.version.version,
      contentHash: released.version.contentHash,
      capabilities: released.version.capabilities,
      executionPolicy: released.version.executionPolicy,
      capabilityVersions: released.version.capabilityVersions,
      bindings: released.version.bindings,
      releasedAt: released.version.releasedAt,
      sourceDraftRevision: 0,
    });
    await updateActivity(trx, released.activity, 1);
  } else {
    const registrationArtifact = {
      schemaVersion: 1,
      lifecycleVersion: 1,
      lifecycle: "final",
      rosterStatus: "unknown",
    } as const;
    const capabilityEntries = {
      questionnaire: artifacts.capabilityPlan(
        "questionnaire",
        artifacts.questionnaire,
        artifacts.contentHashes.questionnaire,
      ),
      competition: artifacts.capabilityPlan(
        "competition",
        artifacts.competition,
        artifacts.contentHashes.competition,
      ),
      registration: artifacts.capabilityPlan(
        "registration",
        registrationArtifact,
        stableHash(registrationArtifact),
      ),
      materials: artifacts.capabilityPlan("materials", {
        schemaVersion: 1,
        maxBytes: 25_000_000,
        allowedPurposes: ["audio", "video", "image", "document"],
      }, stableHash({ materials: 1 })),
      ...(hasGrouping
        ? {
            grouping: artifacts.capabilityPlan(
              "grouping",
              { schemaVersion: 1 },
              stableHash({ grouping: 1 }),
            ),
          }
        : {}),
    };
    await insertRelease(trx, {
      activityId,
      version: 1,
      contentHash: bundleHash,
      capabilities: capabilityEntries,
      // Imported history is read-only: no command may claim a running session.
      executionPolicy: { declaredScopes: ["judging"], conflicts: {}, runtimeContractVersion: 1, commandScopes: {} },
      capabilityVersions: {
        questionnaire: "1",
        competition: "1",
        registration: "1",
        materials: "1",
      },
      bindings: [],
      releasedAt: bundle.exportedAt,
      sourceDraftRevision: 1,
    });
  }

  // Adoption registers answers against the snapshot compiled from the bundle
  // questionnaire, not the legacy exporter's standalone hash.
  const questionnaire = (adoption?.compiled.capabilities.questionnaire?.artifact as
    | { version: string; schemaHash: string }
    | undefined) ?? artifacts.questionnaire;
  const prefix = `legacy-${bundle.activity.publicCode}`;
  const allowedStatuses = new Set(["draft", "submitted", "need_supplement", "approved", "rejected", "withdrawn"]);
  for (const registration of bundle.registrations) {
    if (!allowedStatuses.has(registration.status)) {
      throw new DomainError("LEGACY_BUNDLE_INVALID", `Unknown registration status ${registration.status}.`);
    }
    await insertRegistration(trx, {
      id: `${prefix}-reg-${registration.legacyId}`,
      activityId,
      participantId: registration.participantKey,
      questionnaireVersion: questionnaire.version,
      questionnaireHash: questionnaire.schemaHash,
      status: registration.status as "draft" | "submitted" | "need_supplement" | "approved" | "rejected" | "withdrawn",
      answers: registration.answers,
      revision: 1,
      reviewNote: registration.reviewNote,
      ...(registration.reviewedBy === null ? {} : { reviewedBy: registration.reviewedBy }),
    });
  }

  if (bundle.roster.status === "final") {
    const approved = bundle.registrations.filter((row) => row.status === "approved").length;
    if (approved !== bundle.roster.approvedCount) {
      throw new DomainError(
        "LEGACY_RECONCILIATION_FAILED",
        "The declared roster size does not match the approved registrations.",
      );
    }
    await upsertRoster(trx, activityId, {
      status: "final",
      revision: 1,
      approvedCount: approved,
      finalizedAt: bundle.roster.finalizedAt ?? bundle.exportedAt,
    }, 0);
  }

  const materialStatuses = new Set(["uploaded", "approved", "needs_supplement"]);
  for (const material of bundle.materials) {
    if (!materialStatuses.has(material.status)) {
      throw new DomainError("LEGACY_BUNDLE_INVALID", `Unknown material status ${material.status}.`);
    }
    await insertMaterial(trx, {
      id: `${prefix}-material-${material.legacyId}`,
      activityId,
      registrationId: `${prefix}-reg-${material.registrationLegacyId}`,
      questionKey: material.questionKey,
      storageKey: material.storagePath === undefined || material.storagePath === null || material.storagePath === ""
        ? `legacy:${material.legacyId}`
        : `legacy-file:${material.storagePath}`,
      originalName: material.originalName,
      contentType: material.contentType,
      byteLength: material.byteLength,
      ownerActorId: "legacy-import",
      status: material.status as "uploaded" | "approved" | "needs_supplement",
      reviewNote: material.reviewNote,
      reviewedBy: null,
      reviewedAt: null,
      revision: 1,
      current: true,
      contentReady: material.storagePath !== undefined && material.storagePath !== null && material.storagePath !== "",
    });
  }

  for (const check of bundle.materialChecks ?? []) {
    await insertMaterialCheck(trx, {
      id: `${prefix}-check-${check.legacyId}`,
      activityId,
      registrationId: `${prefix}-reg-${check.registrationLegacyId}`,
      slotKey: check.questionKey,
      itemName: check.itemName,
      purpose: check.filePurpose,
      acceptedPurposes: check.acceptedFilePurposes,
      status: check.status,
      required: check.required,
      reviewNote: check.reviewNote,
      revision: 1,
    });
  }

  const roundsByLegacy = new Map<number, StoredRound>();
  for (const round of bundle.rounds) {
    const stored: StoredRound = {
      // Adoption must use the same canonical identity the resolver derives
      // from the release round key; historical snapshots keep their own id.
      id: adoption === undefined
        ? `${prefix}-round-${round.legacyId}`
        : idFromCommand("round", `${activityId}:${round.key}`),
      activityId,
      roundKey: round.key,
      releaseVersion: 1,
      // Adoption starts from preparation: the round exists but is not locked
      // and carries no legacy score/panel facts.
      state: adoption === undefined ? round.state : "prepared",
      revision: 0,
      scoreVersion: 0,
      minimumJudges: round.minimumJudges,
      judgeCount: round.judgeCount,
      completionMode: round.completion,
      scoringMethod: round.scoringMethod,
      advanceCount: round.advanceCount,
      currentPanelId: null,
      lockedAt: null,
    };
    await insertRound(trx, stored);
    roundsByLegacy.set(round.legacyId, stored);
  }

  if (adoption === undefined) {
    await importCompetition(trx, bundle, activityId, prefix, roundsByLegacy);
  }
  const groupingNotes: string[] = [];
  if (bundle.grouping !== undefined && bundle.grouping.length > 0) {
    const participantKeys = new Set(bundle.registrations.map((row) => row.participantKey));
    const roundIdByLegacy = new Map(
      [...roundsByLegacy.entries()].map(([legacyId, round]) => [legacyId, round.id] as const),
    );
    await importGrouping(
      trx,
      activityId,
      bundle.activity.publicCode,
      prefix,
      bundle.grouping,
      participantKeys,
      roundIdByLegacy,
      deps.now(),
      groupingNotes,
    );
  }
  if (adoption === undefined) {
    await importVoting(trx, bundle, activityId, prefix);
    await importResults(trx, bundle, activityId, bundleHash, prefix);
  }

  const imported = await countImported(trx, activityId);
  const checks: LegacyImportCheck[] = [
    check("registrations", imported.registrations, bundle.counts.registrations),
    check("approvedRegistrations", imported.approvedRegistrations, bundle.counts.approvedRegistrations),
    check("materials", imported.materials, bundle.counts.materials),
    check("materialChecks", imported.materialChecks ?? 0, bundle.materialChecks?.length ?? 0),
    check("rounds", imported.rounds, bundle.counts.rounds),
  ];
  if (adoption === undefined) {
    checks.push(
      check("scores", imported.scores, bundle.counts.scores),
      check("ballots", imported.ballots, bundle.counts.ballots),
      check("releases", imported.releases, bundle.counts.releases),
    );

    const expectedOptionCounts = new Map<number, number>();
    for (const ballot of bundle.voting.ballots) {
      for (const optionId of ballot.optionLegacyIds) {
        expectedOptionCounts.set(optionId, (expectedOptionCounts.get(optionId) ?? 0) + 1);
      }
    }
    const recordRows = await trx.selectFrom("vote_record").select(["option_id"])
      .where("activity_id", "=", activityId)
      .execute();
    const actualOptionCounts = new Map<string, number>();
    for (const row of recordRows) {
      actualOptionCounts.set(row.option_id, (actualOptionCounts.get(row.option_id) ?? 0) + 1);
    }
    const expectedOptionSignature = [...expectedOptionCounts.entries()]
      .map(([optionId, count]) => `${prefix}-option-${optionId}:${count}`)
      .sort()
      .join(",");
    const actualOptionSignature = [...actualOptionCounts.entries()]
      .map(([optionId, count]) => `${optionId}:${count}`)
      .sort()
      .join(",");
    checks.push(check("ballots.optionCounts", actualOptionSignature, expectedOptionSignature));

    const releaseRows = await trx.selectFrom("result_release").select(["snapshot"])
      .where("activity_id", "=", activityId)
      .execute();
    const normalizeSnapshot = (value: unknown): unknown =>
      typeof value === "string" ? JSON.parse(value) as unknown : value;
    const actualSnapshotSignature = releaseRows
      .map((row) => stableHash(normalizeResultSnapshot(
        normalizeSnapshot(row.snapshot),
        "",
        bundle.activity.title,
      )))
      .sort()
      .join(",");
    const expectedSnapshotSignature = bundle.results.releases
      .map((release) => stableHash(normalizeResultSnapshot(
        release.snapshot,
        release.stageKey,
        bundle.activity.title,
      )))
      .sort()
      .join(",");
    checks.push(check("releases.snapshotHash", actualSnapshotSignature, expectedSnapshotSignature));
  }
  const failed = checks.filter((item) => !item.ok);
  if (failed.length > 0) {
    throw new DomainError(
      "LEGACY_RECONCILIATION_FAILED",
      `Reconciliation failed: ${failed.map((item) => `${item.name} ${item.actual} != ${item.expected}`).join(", ")}`,
    );
  }

  const unsupported = [
    ...bundle.unsupported,
    ...groupingNotes.map((reason) => ({ kind: "grouping", reason })),
  ];
  await appendEngineEvent(trx, deps, {
    type: "LegacyBundleImported",
    activityId,
    aggregateType: "activity",
    aggregateId: activityId,
    revision: 1,
    capability: "engine",
    payload: {
      publicCode: bundle.activity.publicCode,
      bundleHash,
      mode: adoption === undefined ? "historical" : "adoption",
      capabilities: enabledCapabilities,
      imported,
      excluded: bundle.excluded,
      unsupported,
    },
  });
  return {
    mode: adoption === undefined ? "historical" : "adoption",
    publicCode: bundle.activity.publicCode,
    activityId,
    bundleHash,
    dryRun: false,
    imported,
    excluded: bundle.excluded,
    unsupported,
    checks: adoption === undefined ? checks : [...checks, ...adoption.checks],
    ...(adoption === undefined
      ? {}
      : {
          capabilities: adoption.capabilities,
          definitionVersion: 1,
          releaseHash: adoption.compiled.contentHash,
          semanticReady: adoption.semanticReady,
          warnings: adoption.warnings,
        }),
  };
}

export interface AdoptLegacyInput extends LegacyAdoptionOptions {
  readonly commandId: string;
  readonly bundle: unknown;
  readonly dryRun: boolean;
}

/**
 * Operational adoption: the same v1 facts, but the activity is given a real
 * Plus composition, compiled definition and release, then preparation facts are
 * imported. Historical scores/ballots/results stay in v1.
 */
export async function adoptLegacyBundle(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: AdoptLegacyInput,
): Promise<LegacyImportResult> {
  const bundle = parseLegacyBundle(input.bundle);
  const bundleHash = stableHash(bundle);
  const activityId = activityIdFor(bundle.activity.publicCode);
  const actor = runtimeActor(deps);
  const plan = buildAdoptionPlan(bundle, input);

  if (input.dryRun) {
    return {
      report: {
        mode: "adoption",
        publicCode: bundle.activity.publicCode,
        activityId,
        bundleHash,
        dryRun: true,
        imported: plannedCounts(bundle),
        excluded: bundle.excluded,
        unsupported: bundle.unsupported,
        checks: [...declaredChecks(bundle), ...plan.checks],
        capabilities: plan.capabilities,
        definitionVersion: 1,
        releaseHash: plan.compiled.contentHash,
        semanticReady: plan.semanticReady,
        warnings: plan.warnings,
      },
    };
  }

  const outcome = await executeCommand(db, {
    commandId: input.commandId,
    activityId,
    capability: "engine",
    commandType: "activity.legacy.adopt",
    actor,
    payload: { bundleHash, publicCode: bundle.activity.publicCode, capabilities: plan.capabilities },
  }, async (trx) => {
    const report = await importActivity(trx, bundle, activityId, bundleHash, deps, plan);
    return { body: report, status: 201 };
  });
  return { report: outcome.body };
}

export async function importLegacyBundle(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: ImportLegacyInput,
): Promise<LegacyImportResult> {
  const bundle = parseLegacyBundle(input.bundle);
  const bundleHash = stableHash(bundle);
  const activityId = activityIdFor(bundle.activity.publicCode);
  const actor = runtimeActor(deps);

  if (input.dryRun) {
    return {
      report: {
        mode: "historical",
        publicCode: bundle.activity.publicCode,
        activityId,
        bundleHash,
        dryRun: true,
        imported: plannedCounts(bundle),
        excluded: bundle.excluded,
        unsupported: bundle.unsupported,
        checks: declaredChecks(bundle),
      },
    };
  }

  requireNoUnsupported(bundle.unsupported);
  const outcome = await executeCommand(db, {
    commandId: input.commandId,
    activityId,
    capability: "engine",
    commandType: "activity.legacy.import",
    actor,
    payload: { bundleHash, publicCode: bundle.activity.publicCode },
  }, async (trx) => {
    const report = await importActivity(trx, bundle, activityId, bundleHash, deps);
    return { body: report, status: 201 };
  });
  return { report: outcome.body };
}
