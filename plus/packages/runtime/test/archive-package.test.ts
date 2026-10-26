import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SessionRecord, StoredResultRelease, StoredStageResult } from "@artflow-plus/db";
import type { ArchiveManifest, RuntimeEvent } from "@artflow-plus/domain";
import { strFromU8, unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createLocalArchiveStorage } from "../src/archive-storage.js";
import { buildArchivePackage } from "../src/archive-package.js";

const snapshot = {
  activityTitle: "2026 院十佳",
  publicTitle: "2026 院十佳 · 正式赛果",
  stageKey: "final_podium",
  decisions: [
    { rank: 1, contestantId: "singer-a", score: "98.30" },
    { rank: 2, contestantId: "singer-b", score: "97.80" },
  ],
  awards: [{ award: '最佳"人气",奖', contestantId: "singer-a" }],
};

const releases: StoredResultRelease[] = [
  {
    id: "release-legacy",
    activityId: "act-1",
    publicationId: "publication-1",
    stageResultId: "stage-1",
    stageKey: "final_podium",
    status: "superseded",
    snapshot: null,
    snapshotCandidateRevision: 2,
    resultVersion: 2,
    postVersion: 1,
    inputFingerprint: "fp-legacy",
    note: "legacy",
    releasedAt: "2026-10-19T18:00:00.000Z",
    supersededAt: "2026-10-19T19:00:00.000Z",
    revision: 1,
  },
  {
    id: "release-1",
    activityId: "act-1",
    publicationId: "publication-1",
    stageResultId: "stage-1",
    stageKey: "final_podium",
    status: "active",
    snapshot,
    snapshotCandidateRevision: 3,
    resultVersion: 3,
    postVersion: 1,
    inputFingerprint: "fp-1",
    note: "release",
    releasedAt: "2026-10-20T18:00:00.000Z",
    revision: 0,
  },
];

const stageResults: StoredStageResult[] = [
  {
    id: "stage-1",
    activityId: "act-1",
    stageKey: "final_podium",
    status: "confirmed",
    candidateRevision: 3,
    sourceCandidateRevision: 3,
    inputFingerprint: "fp-1",
    decisions: snapshot.decisions,
    awards: snapshot.awards,
    revision: 1,
    confirmedAt: "2026-10-20T17:00:00.000Z",
  },
];

const sessions: SessionRecord[] = [
  {
    id: "session-formal",
    activityId: "act-1",
    definitionVersion: 1,
    contentHash: "hash-1",
    scope: "publishing",
    mode: "formal",
    status: "closed",
    revision: 1,
    openedAt: "2026-10-20T16:00:00.000Z",
    closedAt: "2026-10-20T17:00:00.000Z",
  },
  {
    id: "session-rehearsal",
    activityId: "act-1",
    definitionVersion: 1,
    contentHash: "hash-1",
    scope: "judging",
    mode: "rehearsal",
    status: "closed",
    revision: 1,
    openedAt: "2026-10-19T16:00:00.000Z",
    closedAt: "2026-10-19T17:00:00.000Z",
  },
];

const events: RuntimeEvent[] = [
  {
    sequence: 1,
    eventId: "event-1",
    type: "ResultReleased",
    occurredAt: "2026-10-20T18:00:00.000Z",
    activityId: "act-1",
    capability: "publishing",
    aggregateId: "release-1",
    revision: 0,
    mode: "formal",
    scope: "publishing",
    actorId: "staff",
    payload: { secret: "payload-not-exported", fingerprint: "fp-1" },
  },
];

describe("archive package", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "artflow-archive-"));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("stores and reads a file with a digest and rejects traversal", async () => {
    const storage = createLocalArchiveStorage(root);
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const stored = await storage.put("act-1/v1.zip", bytes);
    expect(stored.size).toBe(4);
    expect(stored.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(Array.from(await storage.read("act-1/v1.zip"))).toEqual([1, 2, 3, 4]);
    await storage.remove("act-1/v1.zip");
    await expect(storage.put("../evil/v1.zip", bytes)).rejects.toThrow(/Unsafe archive key/);
  });

  it("builds a whitelist-only ZIP with a manifest and legacy snapshot handling", () => {
    const output = buildArchivePackage({
      packageId: "archive-1",
      version: 1,
      activity: {
        id: "act-1",
        publicCode: "ABC123",
        title: "2026 院十佳",
        enabledCapabilities: ["publishing", "archive"],
        activeDefinitionVersion: 1,
      },
      releases,
      stageResults,
      sessions,
      events,
      archivedAt: "2026-10-21T00:00:00.000Z",
      archivedBy: "staff",
    });

    const entries = unzipSync(output.bytes);
    expect(Object.keys(entries).sort()).toEqual([
      "README.txt",
      "activity.json",
      "awards.csv",
      "events-summary.csv",
      "manifest.json",
      "releases.json",
      "results.csv",
      "sessions.json",
      "stage-results.json",
    ]);

    const manifest = JSON.parse(strFromU8(entries["manifest.json"] ?? new Uint8Array())) as ArchiveManifest;
    expect(manifest.format).toBe("zip-json-csv");
    expect(manifest.excludedFields).toEqual(expect.arrayContaining(["input_fingerprint", "authority_hash"]));
    for (const artifact of manifest.artifacts) {
      const bytes = entries[artifact.name];
      expect(bytes).toBeDefined();
      expect(createHash("sha256").update(bytes ?? new Uint8Array()).digest("hex")).toBe(artifact.sha256);
      expect(bytes?.byteLength).toBe(artifact.size);
    }

    const releaseJson = JSON.parse(strFromU8(entries["releases.json"] ?? new Uint8Array())) as {
      releaseId: string;
      snapshot: unknown;
    }[];
    expect(releaseJson.find((item) => item.releaseId === "release-legacy")?.snapshot).toBeNull();
    expect(output.summary.releaseRows).toEqual([
      {
        release: "release-legacy",
        snapshotAvailable: false,
        snapshotActivityTitle: null,
        snapshotPublicTitle: null,
      },
      {
        release: "release-1",
        snapshotAvailable: true,
        snapshotActivityTitle: "2026 院十佳",
        snapshotPublicTitle: "2026 院十佳 · 正式赛果",
      },
    ]);

    const sessionsJson = JSON.parse(strFromU8(entries["sessions.json"] ?? new Uint8Array())) as { sessionId: string }[];
    expect(sessionsJson.map((item) => item.sessionId)).toEqual(["session-formal"]);

    const awardBytes = entries["awards.csv"] ?? new Uint8Array();
    expect([...awardBytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const awardsCsv = strFromU8(awardBytes);
    expect(awardsCsv).toContain('"最佳""人气"",奖"');

    const eventsCsv = strFromU8(entries["events-summary.csv"] ?? new Uint8Array());
    expect(eventsCsv).toContain("ResultReleased");
    expect(eventsCsv).not.toContain("payload-not-exported");

    const allText = Object.values(entries)
      .map((bytes) => strFromU8(bytes))
      .join("\n");
    expect(allText).not.toContain("fp-1");
    expect(allText).not.toContain("fp-legacy");
  });
});
