import type { Database, StoredRound } from "@artflow-plus/db";
import {
  insertJudgeSeat,
  insertMaterial,
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
  updateRound,
  upsertRoster,
} from "@artflow-plus/db";
import { computeRanking, decimalValue, DomainError } from "@artflow-plus/domain";
import type { ResultAward, ResultDecision, ResultSnapshot } from "@artflow-plus/domain";
import type { Kysely, Transaction } from "kysely";

import { executeCommand } from "./command.js";
import { runtimeActor, type RuntimeDeps } from "./deps.js";
import { appendEngineEvent } from "./events.js";
import { stableHash } from "./hash.js";
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

export interface LegacyImportReport {
  readonly publicCode: string;
  readonly activityId: string;
  readonly bundleHash: string;
  readonly dryRun: boolean;
  readonly imported: LegacyCounts;
  readonly excluded: LegacyExcluded;
  readonly unsupported: LegacyBundle["unsupported"];
  readonly checks: readonly LegacyImportCheck[];
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

function plannedCounts(bundle: LegacyBundle): LegacyCounts {
  return {
    registrations: bundle.registrations.length,
    approvedRegistrations: bundle.registrations.filter((row) => row.status === "approved").length,
    materials: bundle.materials.length,
    rounds: bundle.rounds.length,
    scores: bundle.competition.scores.length,
    ballots: bundle.voting.ballots.length,
    releases: bundle.results.releases.length,
  };
}

function declaredChecks(bundle: LegacyBundle): LegacyImportCheck[] {
  const planned = plannedCounts(bundle);
  return (Object.keys(planned) as (keyof LegacyCounts)[]).map((key) =>
    check(`planned.${key}`, planned[key], bundle.counts[key]),
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
    panelId: string,
    members: readonly { readonly judgeId: string; readonly seatKey: string }[],
  ): Promise<RoundPanel> => {
    await insertPanelSnapshot(trx, {
      id: panelId,
      activityId,
      roundId: round.id,
      version: 1,
      state: "active",
      expectedJudges: members.length,
      minimumJudges: round.minimumJudges,
      rosterDigest: stableHash({ round: round.id, members }),
      contextVersion: 1,
      current: true,
    });
    const seatsByJudge = new Map<string, string>();
    for (const member of members) {
      await insertPanelMember(trx, { panelId, judgeId: member.judgeId, seatKey: member.seatKey });
      const seatId = seatIds.get(`${roundLegacyId}:${member.judgeId}`) ??
        `${prefix}-seat-synth-${roundLegacyId}-${member.seatKey}`;
      await insertJudgeSeat(trx, {
        id: seatId,
        panelId,
        judgeId: member.judgeId,
        state: "assigned",
        revision: 0,
      });
      seatsByJudge.set(member.judgeId, seatId);
    }
    const updated = await updateRound(trx, { ...round, currentPanelId: panelId }, round.revision);
    roundsByLegacy.set(roundLegacyId, updated);
    return { id: panelId, members, seatsByJudge };
  };

  for (const panel of bundle.competition.panels) {
    const round = roundsByLegacy.get(panel.roundLegacyId);
    if (round === undefined) {
      throw new DomainError("LEGACY_BUNDLE_INVALID", "A panel references an unknown round.");
    }
    panelsByRound.set(
      panel.roundLegacyId,
      await createPanel(round, panel.roundLegacyId, `${prefix}-panel-${panel.legacyId}`, panel.members),
    );
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
      await createPanel(stored, round.legacyId, `${prefix}-panel-synth-${round.legacyId}`, members),
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
      const sum = totals.reduce((total, value) => total + value, 0);
      return {
        contestantId: contestantKey,
        total: decimalValue(sum / totals.length),
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
      decisions: stage.decisions as unknown as readonly ResultDecision[],
      awards: stage.awards as unknown as readonly ResultAward[],
      note: "",
      revision: 1,
      confirmedAt: stage.confirmedAt,
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
        decisions: (snapshot.decisions ?? []) as readonly ResultDecision[],
        awards: (snapshot.awards ?? []) as readonly ResultAward[],
        note: release.note,
        revision: 1,
        confirmedAt: release.releasedAt,
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

async function importActivity(
  trx: Transaction<Database>,
  bundle: LegacyBundle,
  activityId: string,
  bundleHash: string,
  deps: RuntimeDeps,
): Promise<LegacyImportReport> {
  const existing = await trx.selectFrom("activity").select("id")
    .where("public_code", "=", bundle.activity.publicCode)
    .executeTakeFirst();
  if (existing !== undefined) {
    throw new DomainError("LEGACY_ACTIVITY_EXISTS", "An activity with this public code already exists.");
  }
  const artifacts = plans(bundle);
  const status = bundle.results.releases.some((release) => release.status === "active")
    ? "closed"
    : "active";
  await trx.insertInto("activity").values({
    id: activityId,
    public_code: bundle.activity.publicCode,
    title: bundle.activity.title,
    status,
    revision: 1,
    enabled_capabilities: JSON.stringify(LEGACY_CAPABILITIES),
    active_definition_version: 1,
  }).execute();

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
    registration: artifacts.capabilityPlan("registration", {
      schemaVersion: 1,
      lifecycleVersion: 1,
      rosterStatus: "unknown",
    }, stableHash({ registration: 1 })),
    materials: artifacts.capabilityPlan("materials", {
      schemaVersion: 1,
      maxBytes: 25_000_000,
      allowedPurposes: ["audio", "video", "image", "document"],
    }, stableHash({ materials: 1 })),
  };
  await insertRelease(trx, {
    activityId,
    version: 1,
    contentHash: bundleHash,
    capabilities: capabilityEntries,
    executionPolicy: { declaredScopes: ["judging"], conflicts: {}, runtimeContractVersion: 1 },
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

  const questionnaire = artifacts.questionnaire;
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
      storageKey: `legacy:${material.legacyId}`,
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
    });
  }

  const roundsByLegacy = new Map<number, StoredRound>();
  for (const round of bundle.rounds) {
    const stored: StoredRound = {
      id: `${prefix}-round-${round.legacyId}`,
      activityId,
      roundKey: round.key,
      releaseVersion: 1,
      state: round.state,
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

  await importCompetition(trx, bundle, activityId, prefix, roundsByLegacy);
  await importVoting(trx, bundle, activityId, prefix);
  await importResults(trx, bundle, activityId, bundleHash, prefix);

  const imported = await countImported(trx, activityId);
  const checks: LegacyImportCheck[] = [
    check("registrations", imported.registrations, bundle.counts.registrations),
    check("approvedRegistrations", imported.approvedRegistrations, bundle.counts.approvedRegistrations),
    check("materials", imported.materials, bundle.counts.materials),
    check("rounds", imported.rounds, bundle.counts.rounds),
    check("scores", imported.scores, bundle.counts.scores),
    check("ballots", imported.ballots, bundle.counts.ballots),
    check("releases", imported.releases, bundle.counts.releases),
  ];

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
  const failed = checks.filter((item) => !item.ok);
  if (failed.length > 0) {
    throw new DomainError(
      "LEGACY_RECONCILIATION_FAILED",
      `Reconciliation failed: ${failed.map((item) => `${item.name} ${item.actual} != ${item.expected}`).join(", ")}`,
    );
  }

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
      imported,
      excluded: bundle.excluded,
      unsupported: bundle.unsupported,
    },
  });
  return {
    publicCode: bundle.activity.publicCode,
    activityId,
    bundleHash,
    dryRun: false,
    imported,
    excluded: bundle.excluded,
    unsupported: bundle.unsupported,
    checks,
  };
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
