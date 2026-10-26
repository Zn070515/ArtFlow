import type { Database } from "@artflow-plus/db";
import {
  insertMaterial,
  insertRegistration,
  insertRelease,
  insertRound,
  upsertRoster,
} from "@artflow-plus/db";
import { DomainError } from "@artflow-plus/domain";
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

  for (const round of bundle.rounds) {
    await insertRound(trx, {
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
    });
  }

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
