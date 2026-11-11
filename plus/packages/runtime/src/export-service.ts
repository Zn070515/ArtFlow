import { randomUUID } from "node:crypto";

import type { Database, StoredRegistration } from "@artflow-plus/db";
import {
  insertAudit,
  listCurrentScoreFacts,
  listMaterials,
  listRegistrations,
  listRoundsForActivity,
  listVoteOptions,
  listVoteSessionsForActivity,
  readValidVoteTally,
} from "@artflow-plus/db";
import { DomainError, hasPermission } from "@artflow-plus/domain";
import type { ExecutionMode } from "@artflow-plus/domain";
import type { Kysely } from "kysely";

import { runtimeActor, type RuntimeDeps } from "./deps.js";

export type ExportKind = "registrations" | "materials" | "scores" | "votes";

export interface ExportResult {
  readonly filename: string;
  readonly csv: string;
}

function answerText(registration: StoredRegistration, keys: readonly string[]): string {
  for (const key of keys) {
    const value = registration.answers[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return "";
}

function cell(value: unknown): string {
  return `"${String(value ?? "").split('"').join('""')}"`;
}

function row(values: readonly unknown[]): string {
  return values.map(cell).join(",");
}

async function requireExportPermission(
  actor: Parameters<typeof hasPermission>[0],
  kind: ExportKind,
): Promise<void> {
  const allowed =
    kind === "registrations" || kind === "materials"
      ? hasPermission(actor, "registration.review") || hasPermission(actor, "registration.manage")
      : kind === "scores"
        ? hasPermission(actor, "competition.manage")
        : hasPermission(actor, "result.manage") || hasPermission(actor, "voting.manage");
  if (!allowed) throw new DomainError("FORBIDDEN", `The actor cannot export ${kind}.`);
}

async function registrationRows(
  db: Kysely<Database>,
  activityId: string,
): Promise<string[]> {
  const registrations = await listRegistrations(db, activityId);
  return [
    row(["participantId", "name", "studentId", "song", "status", "revision", "reviewNote"]),
    ...registrations.map((registration) => row([
      registration.participantId,
      answerText(registration, ["name", "displayName"]),
      answerText(registration, ["student_id", "studentId"]),
      answerText(registration, ["song", "program"]),
      registration.status,
      registration.revision,
      registration.reviewNote ?? "",
    ])),
  ];
}

async function materialRows(
  db: Kysely<Database>,
  activityId: string,
): Promise<string[]> {
  const registrations = await listRegistrations(db, activityId);
  const lines = [row(["participantId", "questionKey", "originalName", "contentType", "byteLength", "status", "contentReady"])];
  for (const registration of registrations) {
    const materials = await listMaterials(db, registration.id);
    for (const material of materials) {
      lines.push(row([
        registration.participantId,
        material.questionKey,
        material.originalName,
        material.contentType,
        material.byteLength,
        material.status,
        material.contentReady === true,
      ]));
    }
  }
  return lines;
}

async function scoreRows(
  db: Kysely<Database>,
  activityId: string,
): Promise<string[]> {
  const modes: readonly ExecutionMode[] = ["test", "rehearsal", "formal"];
  const rounds = await listRoundsForActivity(db, activityId);
  const roundById = new Map(rounds.map((round) => [round.id, round]));
  const lines = [row(["mode", "roundKey", "performanceId", "contestantId", "judgeId", "total", "source"])];
  for (const mode of modes) {
    for (const round of rounds) {
      const facts = await listCurrentScoreFacts(db, round.id, mode);
      for (const fact of facts) {
        lines.push(row([
          mode,
          roundById.get(fact.roundId)?.roundKey ?? fact.roundId,
          fact.performanceId,
          fact.contestantId,
          fact.judgeId,
          fact.total,
          fact.source,
        ]));
      }
    }
  }
  return lines;
}

async function voteRows(
  db: Kysely<Database>,
  activityId: string,
): Promise<string[]> {
  const sessions = await listVoteSessionsForActivity(db, activityId);
  const lines = [row(["sessionId", "status", "optionId", "candidateId", "count", "totalBallots"])];
  for (const session of sessions) {
    const [options, tally] = await Promise.all([
      listVoteOptions(db, session.id),
      readValidVoteTally(db, session.id),
    ]);
    for (const option of options) {
      lines.push(row([
        session.id,
        session.status,
        option.id,
        option.candidateId,
        tally.countsByOption[option.id] ?? 0,
        tally.totalBallots,
      ]));
    }
  }
  return lines;
}

/** Controlled operator export; every export writes an audit entry. */
export async function exportActivityCsv(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: { readonly activityId: string; readonly kind: ExportKind },
): Promise<ExportResult> {
  const actor = runtimeActor(deps);
  await requireExportPermission(actor, input.kind);
  const lines =
    input.kind === "registrations" ? await registrationRows(db, input.activityId)
      : input.kind === "materials" ? await materialRows(db, input.activityId)
        : input.kind === "scores" ? await scoreRows(db, input.activityId)
          : await voteRows(db, input.activityId);
  await db.transaction().execute(async (trx) => {
    await insertAudit(trx, {
      commandId: `export-${randomUUID()}`,
      activityId: input.activityId,
      capability: "export",
      commandType: `export.${input.kind}`,
      actor,
      detail: { kind: input.kind, rows: Math.max(0, lines.length - 1) },
    });
  });
  return {
    filename: `activity-${input.activityId}-${input.kind}.csv`,
    csv: `${lines.join("\n")}\n`,
  };
}
