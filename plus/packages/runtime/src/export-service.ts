import { randomUUID } from "node:crypto";

import type { Database, StoredRegistration } from "@artflow-plus/db";
import {
  getActivity,
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
export type ExportFormat = "csv" | "docx" | "xlsx";
export type ExportCell = string | number | boolean;

/**
 * One authorized, renderer-agnostic export. CSV, DOCX, and XLSX all consume the
 * same table so a format can never quietly change the rows an operator sees.
 */
export interface ExportTable {
  readonly activityId: string;
  readonly kind: ExportKind;
  readonly title: string;
  readonly filenameStem: string;
  readonly headers: readonly string[];
  readonly rows: readonly (readonly ExportCell[])[];
}

function answerText(registration: StoredRegistration, keys: readonly string[]): string {
  for (const key of keys) {
    const value = registration.answers[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return "";
}

/**
 * Operator text can contain newlines (review notes, free-form answers). OOXML
 * text runs cannot carry control characters, so flatten them before any format
 * sees the table; CSV also benefits from the same stable shape.
 */
function plainText(value: unknown): string {
  return String(value ?? "").replace(/[\u0000-\u001F\u007F]/g, " ");
}

function cell(value: unknown): string {
  const text = plainText(value);
  // Spreadsheet applications evaluate a leading =, +, -, @, tab, or carriage
  // return even inside quotes. A leading apostrophe keeps operator-supplied
  // text as text; DOCX/XLSX already use explicit text cells.
  const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${guarded.split('"').join('""')}"`;
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

async function registrationTable(
  db: Kysely<Database>,
  activityId: string,
): Promise<{ headers: readonly string[]; rows: readonly (readonly ExportCell[])[] }> {
  const registrations = await listRegistrations(db, activityId);
  return {
    headers: ["participantId", "name", "studentId", "song", "status", "revision", "reviewNote"],
    rows: registrations.map((registration) => [
      registration.participantId,
      answerText(registration, ["name", "displayName"]),
      answerText(registration, ["student_id", "studentId"]),
      answerText(registration, ["song", "program"]),
      registration.status,
      registration.revision,
      registration.reviewNote ?? "",
    ]),
  };
}

async function materialTable(
  db: Kysely<Database>,
  activityId: string,
): Promise<{ headers: readonly string[]; rows: readonly (readonly ExportCell[])[] }> {
  const registrations = await listRegistrations(db, activityId);
  const rows: ExportCell[][] = [];
  for (const registration of registrations) {
    const materials = await listMaterials(db, registration.id);
    for (const material of materials) {
      rows.push([
        registration.participantId,
        material.questionKey,
        material.originalName,
        material.contentType,
        material.byteLength,
        material.status,
        material.contentReady === true,
      ]);
    }
  }
  return {
    headers: [
      "participantId",
      "questionKey",
      "originalName",
      "contentType",
      "byteLength",
      "status",
      "contentReady",
    ],
    rows,
  };
}

async function scoreTable(
  db: Kysely<Database>,
  activityId: string,
): Promise<{ headers: readonly string[]; rows: readonly (readonly ExportCell[])[] }> {
  const modes: readonly ExecutionMode[] = ["test", "rehearsal", "formal"];
  const rounds = await listRoundsForActivity(db, activityId);
  const roundById = new Map(rounds.map((round) => [round.id, round]));
  const rows: ExportCell[][] = [];
  for (const mode of modes) {
    for (const round of rounds) {
      const facts = await listCurrentScoreFacts(db, round.id, mode);
      for (const fact of facts) {
        rows.push([
          mode,
          roundById.get(fact.roundId)?.roundKey ?? fact.roundId,
          fact.performanceId,
          fact.contestantId,
          fact.judgeId,
          fact.total,
          fact.source,
        ]);
      }
    }
  }
  return {
    headers: ["mode", "roundKey", "performanceId", "contestantId", "judgeId", "total", "source"],
    rows,
  };
}

async function voteTable(
  db: Kysely<Database>,
  activityId: string,
): Promise<{ headers: readonly string[]; rows: readonly (readonly ExportCell[])[] }> {
  const sessions = await listVoteSessionsForActivity(db, activityId);
  const rows: ExportCell[][] = [];
  for (const session of sessions) {
    const [options, tally] = await Promise.all([
      listVoteOptions(db, session.id),
      readValidVoteTally(db, session.id),
    ]);
    for (const option of options) {
      rows.push([
        session.id,
        session.status,
        option.id,
        option.candidateId,
        tally.countsByOption[option.id] ?? 0,
        tally.totalBallots,
      ]);
    }
  }
  return {
    headers: ["sessionId", "status", "optionId", "candidateId", "count", "totalBallots"],
    rows,
  };
}

/** Reads the authorized table without writing an audit entry yet. */
export async function exportActivityTable(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: { readonly activityId: string; readonly kind: ExportKind },
): Promise<ExportTable> {
  await requireExportPermission(runtimeActor(deps), input.kind);
  const activity = await getActivity(db, input.activityId);
  if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
  const table =
    input.kind === "registrations" ? await registrationTable(db, input.activityId)
      : input.kind === "materials" ? await materialTable(db, input.activityId)
        : input.kind === "scores" ? await scoreTable(db, input.activityId)
          : await voteTable(db, input.activityId);
  return {
    activityId: input.activityId,
    kind: input.kind,
    title: plainText(activity.title),
    filenameStem: `activity-${input.activityId}-${input.kind}`,
    headers: table.headers.map(plainText),
    rows: table.rows.map((row) =>
      row.map((value) => (typeof value === "string" ? plainText(value) : value))
    ),
  };
}

/** Every successful export writes exactly one audit entry. */
export async function recordExportAudit(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  table: ExportTable,
  format: ExportFormat,
): Promise<void> {
  const actor = runtimeActor(deps);
  await db.transaction().execute(async (trx) => {
    await insertAudit(trx, {
      commandId: `export-${randomUUID()}`,
      activityId: table.activityId,
      capability: "export",
      commandType: `export.${table.kind}`,
      actor,
      detail: { kind: table.kind, format, rows: table.rows.length },
    });
  });
}

/** CSV stays a pure serializer; the route audits after the render succeeds. */
export function serializeCsv(table: ExportTable): string {
  const lines = [
    table.headers.map(cell).join(","),
    ...table.rows.map((row) => row.map(cell).join(",")),
  ];
  return `${lines.join("\n")}\n`;
}

