import type { Database, StoredMaterial, StoredRegistration } from "@artflow-plus/db";
import {
  getActivity,
  getRoster,
  insertAudit,
  listCurrentMaterialsForActivity,
  listCurrentScoreFacts,
  listRegistrations,
  listRoundsForActivity,
  listVoteOptions,
  listVoteSessionsForActivity,
  readValidVoteTally,
} from "@artflow-plus/db";
import type { ActorContext, ExecutionMode } from "@artflow-plus/domain";
import { DomainError, hasPermission } from "@artflow-plus/domain";
import type { Kysely } from "kysely";

import { runtimeActor, type RuntimeDeps } from "./deps.js";

export const STAFF_EXPORT_KINDS = ["registrations", "materials", "scores", "votes"] as const;
export type StaffExportKind = (typeof STAFF_EXPORT_KINDS)[number];

const EXPORT_PERMISSIONS: Readonly<Record<StaffExportKind, readonly string[]>> = {
  registrations: ["registration.review", "registration.manage"],
  materials: ["registration.review", "registration.manage", "materials.review", "materials.manage"],
  scores: ["competition.manage"],
  votes: ["voting.manage", "competition.manage"],
};

const SCORE_MODES: readonly ExecutionMode[] = ["formal", "rehearsal", "test"];

const STATUS_LABELS: Readonly<Record<string, string>> = {
  draft: "草稿",
  submitted: "已提交",
  approved: "已通过",
  need_supplement: "需补充",
  rejected: "未通过",
  withdrawn: "已撤回",
  uploaded: "已上传",
  needs_supplement: "需补充",
};

const TITLE_KEYS = ["song", "program", "title"] as const;
const NAME_KEYS = ["name", "performer"] as const;
const STUDENT_ID_KEYS = ["student_id", "studentId"] as const;

export interface StaffExportFile {
  readonly kind: StaffExportKind;
  readonly filename: string;
  readonly contentType: "text/csv; charset=utf-8";
  readonly body: string;
  readonly rowCount: number;
}

type Cell = string | number | null | undefined;

/**
 * Excel and LibreOffice execute text that starts with a formula marker.
 * Numeric cells cannot carry formulas, so only string values are neutralized.
 */
export function csvCell(value: Cell): string {
  if (value === null || value === undefined) return "";
  const raw = String(value);
  const text = typeof value === "string" && /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function renderSpreadsheet(rows: readonly (readonly Cell[])[]): string {
  const body = rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
  return `\uFEFF${body}\r\n`;
}

function textAnswer(
  answers: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): string {
  for (const key of keys) {
    const value = answers[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return "";
}

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

function rosterLabel(status: "unknown" | "final"): string {
  return status === "final" ? "已定稿" : "未定稿";
}

function requireExportPermission(actor: ActorContext, kind: StaffExportKind): void {
  const permissions = EXPORT_PERMISSIONS[kind];
  if (!permissions.some((permission) => hasPermission(actor, permission))) {
    throw new DomainError("FORBIDDEN", `One of ${permissions.join(", ")} is required.`);
  }
}

export function buildRegistrationSheet(
  rosterStatus: "unknown" | "final",
  registrations: readonly StoredRegistration[],
): { readonly rows: readonly (readonly Cell[])[]; readonly rowCount: number } {
  const header = ["名单状态", "姓名", "学号", "曲目", "状态", "参与者", "审核意见"] as const;
  const roster = rosterLabel(rosterStatus);
  if (registrations.length === 0) {
    return {
      rows: [header, [roster, "（暂无报名）", "", "", "", "", ""]],
      rowCount: 0,
    };
  }
  return {
    rows: [
      header,
      ...registrations.map((registration) => [
        roster,
        textAnswer(registration.answers, NAME_KEYS),
        textAnswer(registration.answers, STUDENT_ID_KEYS),
        textAnswer(registration.answers, TITLE_KEYS),
        statusLabel(registration.status),
        registration.participantId,
        registration.reviewNote ?? "",
      ]),
    ],
    rowCount: registrations.length,
  };
}

export function buildMaterialSheet(
  rosterStatus: "unknown" | "final",
  registrations: readonly StoredRegistration[],
  materials: readonly Pick<
    StoredMaterial,
    "registrationId" | "questionKey" | "originalName" | "contentType" | "byteLength" | "status"
  >[],
): { readonly rows: readonly (readonly Cell[])[]; readonly rowCount: number } {
  const header = ["名单状态", "姓名", "学号", "题目", "文件名", "类型", "字节", "材料状态"] as const;
  const roster = rosterLabel(rosterStatus);
  if (materials.length === 0) {
    return {
      rows: [header, [roster, "（暂无材料）", "", "", "", "", "", ""]],
      rowCount: 0,
    };
  }
  const byId = new Map(registrations.map((registration) => [registration.id, registration]));
  return {
    rows: [
      header,
      ...materials.map((material) => {
        const registration = byId.get(material.registrationId);
        return [
          roster,
          registration === undefined ? "" : textAnswer(registration.answers, NAME_KEYS),
          registration === undefined ? "" : textAnswer(registration.answers, STUDENT_ID_KEYS),
          material.questionKey,
          material.originalName,
          material.contentType,
          material.byteLength,
          statusLabel(material.status),
        ];
      }),
    ],
    rowCount: materials.length,
  };
}

export interface ScoreExportFact {
  readonly roundKey: string;
  readonly mode: string;
  readonly contestantId: string;
  readonly judgeId: string;
  readonly seatId: string;
  readonly total: string;
  readonly source: string;
  readonly criteria: Readonly<Record<string, number>>;
  readonly notes: string;
}

function criteriaText(criteria: Readonly<Record<string, number>>): string {
  return Object.entries(criteria)
    .map(([key, value]) => `${key}=${value}`)
    .join("; ");
}

export function buildScoreSheet(
  facts: readonly ScoreExportFact[],
): { readonly rows: readonly (readonly Cell[])[]; readonly rowCount: number } {
  const header = ["轮次", "模式", "选手", "评委", "席位", "总分", "分项", "来源", "备注"] as const;
  if (facts.length === 0) {
    return {
      rows: [header, ["（暂无评分）", "", "", "", "", "", "", "", ""]],
      rowCount: 0,
    };
  }
  return {
    rows: [
      header,
      ...facts.map((fact) => [
        fact.roundKey,
        fact.mode,
        fact.contestantId,
        fact.judgeId,
        fact.seatId,
        fact.total,
        criteriaText(fact.criteria),
        fact.source,
        fact.notes,
      ]),
    ],
    rowCount: facts.length,
  };
}

export interface VoteExportRow {
  readonly sessionId: string;
  readonly mode: string;
  readonly status: string;
  readonly candidateId: string;
  readonly ordinal: number | "";
  readonly count: number | "";
  readonly totalBallots: number | "";
}

export function buildVoteSheet(
  rows: readonly VoteExportRow[],
): { readonly rows: readonly (readonly Cell[])[]; readonly rowCount: number } {
  const header = ["场次", "模式", "场次状态", "选手", "序号", "有效票", "场次有效票总数"] as const;
  if (rows.length === 0) {
    return {
      rows: [header, ["（暂无投票场次）", "", "", "", "", "", ""]],
      rowCount: 0,
    };
  }
  return {
    rows: [
      header,
      ...rows.map((row) => [
        row.sessionId,
        row.mode,
        row.status,
        row.candidateId,
        row.ordinal,
        row.count,
        row.totalBallots,
      ]),
    ],
    rowCount: rows.length,
  };
}

function fileFor(
  kind: StaffExportKind,
  sheet: { readonly rows: readonly (readonly Cell[])[]; readonly rowCount: number },
): StaffExportFile {
  return {
    kind,
    filename: `${kind}.csv`,
    contentType: "text/csv; charset=utf-8",
    body: renderSpreadsheet(sheet.rows),
    rowCount: sheet.rowCount,
  };
}

async function registrationFile(
  db: Kysely<Database>,
  activityId: string,
): Promise<{ readonly file: StaffExportFile; readonly rosterStatus: "unknown" | "final" }> {
  const roster = await getRoster(db, activityId);
  const registrations = await listRegistrations(db, activityId);
  return {
    rosterStatus: roster.status,
    file: fileFor("registrations", buildRegistrationSheet(roster.status, registrations)),
  };
}

export async function buildStaffExport(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  activityId: string,
  kind: StaffExportKind,
): Promise<StaffExportFile> {
  const actor = runtimeActor(deps);
  requireExportPermission(actor, kind);
  const activity = await getActivity(db, activityId);
  if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");

  let rosterStatus: "unknown" | "final" | "not_applicable" = "not_applicable";
  let file: StaffExportFile;
  if (kind === "registrations") {
    const built = await registrationFile(db, activityId);
    rosterStatus = built.rosterStatus;
    file = built.file;
  } else if (kind === "materials") {
    const roster = await getRoster(db, activityId);
    rosterStatus = roster.status;
    const [registrations, materials] = await Promise.all([
      listRegistrations(db, activityId),
      listCurrentMaterialsForActivity(db, activityId),
    ]);
    file = fileFor(kind, buildMaterialSheet(roster.status, registrations, materials));
  } else if (kind === "scores") {
    const rounds = await listRoundsForActivity(db, activityId);
    const facts: ScoreExportFact[] = [];
    for (const round of rounds) {
      for (const mode of SCORE_MODES) {
        const current = await listCurrentScoreFacts(db, round.id, mode);
        for (const fact of current) {
          facts.push({
            roundKey: round.roundKey,
            mode: fact.mode,
            contestantId: fact.contestantId,
            judgeId: fact.judgeId,
            seatId: fact.seatId,
            total: fact.total,
            source: fact.source,
            criteria: fact.criteria,
            notes: fact.notes,
          });
        }
      }
    }
    file = fileFor(kind, buildScoreSheet(facts));
  } else {
    const sessions = await listVoteSessionsForActivity(db, activityId);
    const voteRows: VoteExportRow[] = [];
    for (const session of sessions) {
      const [options, tally] = await Promise.all([
        listVoteOptions(db, session.id),
        readValidVoteTally(db, session.id),
      ]);
      if (options.length === 0) {
        voteRows.push({
          sessionId: session.id,
          mode: session.mode,
          status: session.status,
          candidateId: "（暂无选项）",
          ordinal: "",
          count: "",
          totalBallots: tally.totalBallots,
        });
        continue;
      }
      for (const option of options) {
        voteRows.push({
          sessionId: session.id,
          mode: session.mode,
          status: session.status,
          candidateId: option.candidateId,
          ordinal: option.ordinal,
          count: tally.countsByOption[option.id] ?? 0,
          totalBallots: tally.totalBallots,
        });
      }
    }
    file = fileFor(kind, buildVoteSheet(voteRows));
  }

  await db.transaction().execute(async (trx) => {
    await insertAudit(trx, {
      commandId: `export-${deps.newEventId()}`,
      activityId,
      capability: "export",
      commandType: `staff.export.${kind}`,
      actor,
      detail: {
        kind,
        rowCount: file.rowCount,
        rosterStatus,
        includesPrivateMedia: false,
      },
    });
  });
  return file;
}
