import { createHash } from "node:crypto";

import type {
  SessionRecord,
  StoredResultRelease,
  StoredStageResult,
} from "@artflow-plus/db";
import { isResultSnapshot } from "@artflow-plus/domain";
import type {
  ArchiveManifest,
  ArchiveManifestArtifact,
  ArchiveReleaseRow,
  ArchiveSummary,
  RuntimeEvent,
} from "@artflow-plus/domain";
import { zipSync } from "fflate";

export const ARCHIVE_EXCLUDED_FIELDS = [
  "input_fingerprint",
  "authority_hash",
  "token",
  "questionnaire_answers",
  "ballot_identity",
  "storage_path",
] as const;

export interface ArchivePackageActivity {
  readonly id: string;
  readonly publicCode: string;
  readonly title: string;
  readonly enabledCapabilities: readonly string[];
  readonly activeDefinitionVersion: number;
}

export interface ArchivePackageInput {
  readonly packageId: string;
  readonly version: number;
  readonly activity: ArchivePackageActivity;
  readonly releases: readonly StoredResultRelease[];
  readonly stageResults: readonly StoredStageResult[];
  readonly sessions: readonly SessionRecord[];
  readonly events: readonly RuntimeEvent[];
  readonly archivedAt: string;
  readonly archivedBy: string;
}

export interface ArchivePackageOutput {
  readonly bytes: Uint8Array;
  readonly manifest: ArchiveManifest;
  readonly summary: ArchiveSummary;
}

function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  // Excel/LibreOffice execute text that starts with a formula marker. Numeric
  // cells cannot carry formulas, so only string values are neutralized.
  const raw = String(value);
  const text = typeof value === "string" && /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csv(rows: readonly (readonly (string | number | null | undefined)[])[]): string {
  const body = rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
  return `﻿${body}\r\n`;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function releaseRecord(release: StoredResultRelease) {
  const snapshot = isResultSnapshot(release.snapshot) ? release.snapshot : null;
  return {
    releaseId: release.id,
    stageKey: release.stageKey,
    status: release.status,
    snapshotCandidateRevision: release.snapshotCandidateRevision,
    releasedAt: release.releasedAt,
    revokedAt: release.revokedAt ?? null,
    supersededAt: release.supersededAt ?? null,
    snapshot:
      snapshot === null
        ? null
        : {
            activityTitle: snapshot.activityTitle,
            publicTitle: snapshot.publicTitle,
            stageKey: snapshot.stageKey,
            decisions: snapshot.decisions,
            awards: snapshot.awards,
          },
  };
}

/** Builds the sealed ZIP. Every entry is a whitelist; no payload/fingerprint/token is copied. */
export function buildArchivePackage(input: ArchivePackageInput): ArchivePackageOutput {
  const encoder = new TextEncoder();
  const entries: Record<string, Uint8Array> = {};
  const artifacts: ArchiveManifestArtifact[] = [];

  function add(name: string, content: string, mediaType: string): void {
    const bytes = encoder.encode(content);
    entries[name] = bytes;
    artifacts.push({ name, mediaType, size: bytes.byteLength, sha256: sha256(bytes) });
  }

  const releases = [...input.releases].sort((left, right) => {
    if (left.releasedAt !== right.releasedAt) return left.releasedAt.localeCompare(right.releasedAt);
    return left.id.localeCompare(right.id);
  });
  const stageResults = [...input.stageResults].sort((left, right) => left.stageKey.localeCompare(right.stageKey));
  const sessions = input.sessions
    .filter((session) => session.mode === "formal")
    .sort((left, right) => {
      if (left.openedAt !== right.openedAt) return left.openedAt.localeCompare(right.openedAt);
      return left.id.localeCompare(right.id);
    });

  add(
    "activity.json",
    JSON.stringify(
      {
        id: input.activity.id,
        publicCode: input.activity.publicCode,
        title: input.activity.title,
        status: "archived",
        enabledCapabilities: input.activity.enabledCapabilities,
        activeDefinitionVersion: input.activity.activeDefinitionVersion,
        archivedAt: input.archivedAt,
        archivedBy: input.archivedBy,
      },
      null,
      2,
    ),
    "application/json",
  );

  add(
    "releases.json",
    JSON.stringify(releases.map(releaseRecord), null, 2),
    "application/json",
  );

  add(
    "stage-results.json",
    JSON.stringify(
      stageResults.map((result) => ({
        stageKey: result.stageKey,
        status: result.status,
        candidateRevision: result.candidateRevision,
        sourceCandidateRevision: result.sourceCandidateRevision,
        decisions: result.decisions,
        awards: result.awards,
        confirmedAt: result.confirmedAt ?? null,
        unlockedAt: result.unlockedAt ?? null,
      })),
      null,
      2,
    ),
    "application/json",
  );

  const resultRows: (string | number | null)[][] = [
    ["stage_key", "release_status", "released_at", "rank", "contestant_id", "score"],
  ];
  const awardRows: (string | number | null)[][] = [
    ["stage_key", "release_status", "award", "contestant_id"],
  ];
  for (const release of releases) {
    const snapshot = release.snapshot;
    if (!isResultSnapshot(snapshot)) continue;
    for (const decision of snapshot.decisions) {
      resultRows.push([
        release.stageKey,
        release.status,
        release.releasedAt,
        decision.rank,
        decision.contestantId,
        decision.score,
      ]);
    }
    for (const award of snapshot.awards) {
      awardRows.push([release.stageKey, release.status, award.award, award.contestantId]);
    }
  }
  add("results.csv", csv(resultRows), "text/csv; charset=utf-8");
  add("awards.csv", csv(awardRows), "text/csv; charset=utf-8");

  add(
    "sessions.json",
    JSON.stringify(
      sessions.map((session) => ({
        sessionId: session.id,
        definitionVersion: session.definitionVersion,
        scope: session.scope,
        mode: session.mode,
        status: session.status,
        openedAt: session.openedAt,
        closedAt: session.closedAt ?? null,
      })),
      null,
      2,
    ),
    "application/json",
  );

  const eventRows: (string | number | null)[][] = [
    ["occurred_at", "type", "capability", "aggregate_id", "actor_id", "mode", "scope"],
  ];
  for (const event of input.events) {
    eventRows.push([
      event.occurredAt,
      event.type,
      event.capability,
      event.aggregateId,
      event.actorId ?? null,
      event.mode ?? null,
      event.scope ?? null,
    ]);
  }
  add("events-summary.csv", csv(eventRows), "text/csv; charset=utf-8");

  add(
    "README.txt",
    [
      "ArtFlow-Plus 永久归档包",
      "",
      `活动：${input.activity.title}`,
      `活动编号：${input.activity.id}`,
      `归档版本：v${input.version}`,
      `归档时间：${input.archivedAt}`,
      `归档人：${input.archivedBy}`,
      "",
      "包含：活动身份、正式结果 release 快照、stage result、正式执行场次、事件摘要。",
      `排除：${ARCHIVE_EXCLUDED_FIELDS.join(", ")}。`,
      "说明：registration/material/vote/score 明细尚未带 mode 分区，本包不包含它们。",
    ].join("\n"),
    "text/plain; charset=utf-8",
  );

  const manifest: ArchiveManifest = {
    schemaVersion: 1,
    packageId: input.packageId,
    activityId: input.activity.id,
    version: input.version,
    sealedAt: input.archivedAt,
    sealedBy: input.archivedBy,
    format: "zip-json-csv",
    artifacts,
    excludedFields: ARCHIVE_EXCLUDED_FIELDS,
    counts: {
      releases: releases.length,
      stageResults: stageResults.length,
      sessions: sessions.length,
      events: input.events.length,
    },
  };
  entries["manifest.json"] = encoder.encode(JSON.stringify(manifest, null, 2));

  const releaseRows: ArchiveReleaseRow[] = releases.map((release) => {
    const snapshot = isResultSnapshot(release.snapshot) ? release.snapshot : null;
    return {
      release: release.id,
      snapshotAvailable: snapshot !== null,
      snapshotActivityTitle: snapshot?.activityTitle ?? null,
      snapshotPublicTitle: snapshot?.publicTitle ?? null,
    };
  });
  const summary: ArchiveSummary = {
    activityPhase: "archived",
    activityInfoTitle: input.activity.title,
    releaseRows,
    excludedFields: ARCHIVE_EXCLUDED_FIELDS,
  };

  return {
    // A fixed DOS epoch keeps the sealed bytes a pure function of the archived
    // content; otherwise fflate stamps each entry with Date.now() and the same
    // data produces a different sha256 on every seal.
    bytes: zipSync(entries, { level: 6, mtime: new Date("1980-01-01T00:00:00Z") }),
    manifest,
    summary,
  };
}
