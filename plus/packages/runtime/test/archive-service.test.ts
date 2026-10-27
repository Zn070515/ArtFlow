import { PUBLISHING_COMMAND_SCOPES } from "@artflow-plus/domain";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  closeDb,
  createDb,
  insertGroupingStage,
  insertRelease,
  insertResultPublication,
  insertResultRelease,
  insertSession,
  insertStageResult,
  migrate,
  readEventsSince,
} from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import type { ActorContext, ExecutionSession } from "@artflow-plus/domain";
import { Client } from "pg";
import { strFromU8, unzipSync } from "fflate";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  archiveActivity,
  getArchiveState,
  readArchiveFile,
  unarchiveActivity,
} from "../src/index.js";
import type { RuntimeDeps } from "../src/index.js";
import { createLocalArchiveStorage } from "../src/archive-storage.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_archive_service_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;
let root: string;
let tick = 0;

const staff: ActorContext = {
  actorId: "archive-staff",
  actorType: "user",
  roles: ["staff"],
  permissions: ["archive.manage"],
};

const snapshot = {
  activityTitle: "2026 院十佳",
  publicTitle: "2026 院十佳 · 正式赛果",
  stageKey: "final_podium",
  decisions: [{ rank: 1, contestantId: "singer-a", score: "98.30" }],
  awards: [{ award: "冠军", contestantId: "singer-a" }],
};

function deps(): RuntimeDeps {
  return {
    actor: staff,
    now: () => new Date(Date.UTC(2026, 9, 20, 12, 0, tick++)).toISOString(),
    newEventId: () => `archive-${randomUUID()}`,
    archiveStorage: createLocalArchiveStorage(root),
  };
}

async function seed(options: {
  readonly activityId?: string;
  readonly status?: "active" | "closed" | "archived";
  readonly capabilities?: readonly string[];
  readonly withRelease?: boolean;
  readonly voteOpen?: boolean;
  readonly sessions?: boolean;
} = {}): Promise<string> {
  const activityId = options.activityId ?? `act-${randomUUID()}`;
  await db.insertInto("activity").values({
    id: activityId,
    public_code: activityId,
    title: "2026 院十佳",
    status: options.status ?? "closed",
    revision: 1,
    enabled_capabilities: JSON.stringify(options.capabilities ?? ["publishing", "archive"]),
    active_definition_version: 1,
  }).execute();
  if (options.withRelease ?? true) {
    await insertStageResult(db, {
      id: `stage-${activityId}`,
      activityId,
      stageKey: "final_podium",
      status: "confirmed",
      candidateRevision: 3,
      sourceCandidateRevision: 3,
      inputFingerprint: "fp-1",
      decisions: snapshot.decisions,
      awards: snapshot.awards,
      note: "",
      revision: 1,
      confirmedAt: "2026-10-20T11:00:00.000Z",
    });
    await insertResultPublication(db, {
      id: `publication-${activityId}`,
      activityId,
      stageKey: "final_podium",
      title: "正式赛果",
      content: "",
      version: 1,
      revision: 0,
    });
    await insertResultRelease(db, {
      id: `release-${activityId}`,
      activityId,
      publicationId: `publication-${activityId}`,
      stageResultId: `stage-${activityId}`,
      stageKey: "final_podium",
      status: "active",
      snapshot,
      snapshotCandidateRevision: 3,
      resultVersion: 3,
      postVersion: 1,
      inputFingerprint: "fp-1",
      note: "release",
      releasedAt: "2026-10-20T11:30:00.000Z",
      revision: 0,
    });
  }
  if (options.voteOpen) {
    await db.insertInto("vote_session").values({
      id: `vote-${activityId}`,
      activity_id: activityId,
      definition_version: 1,
      mode: "formal",
      purpose: "popularity",
      selection_type: "single",
      max_selections: 1,
      identity_policy: "browser",
      scoring_rule: JSON.stringify({ kind: "ballot_share_percent", scale: 100, decimals: 2 }),
      status: "open",
      revision: 0,
      opened_at: "2026-10-20T11:00:00Z",
      closed_at: null,
    }).execute();
  }
  if (options.sessions) {
    await insertRelease(db, {
      activityId,
      version: 1,
      contentHash: "hash",
      capabilities: {},
      executionPolicy: { declaredScopes: ["publishing"], conflicts: {}, runtimeContractVersion: 1, commandScopes: PUBLISHING_COMMAND_SCOPES },
      capabilityVersions: {},
      bindings: [],
      releasedAt: "2026-10-20T10:00:00Z",
      sourceDraftRevision: 1,
    });
    const session = (id: string, mode: "formal" | "rehearsal", scope: string): ExecutionSession => ({
      id,
      activityId,
      definitionVersion: 1,
      contentHash: "hash",
      scope,
      mode,
      status: "closed",
      revision: 1,
    });
    await insertSession(db, session(`session-formal-${activityId}`, "formal", "publishing"), "2026-10-20T10:00:00Z");
    await insertSession(db, session(`session-rehearsal-${activityId}`, "rehearsal", "judging"), "2026-10-19T10:00:00Z");
  }
  return activityId;
}

describe.skipIf(!connectionString)("archive service", () => {
  beforeAll(async () => {
    if (!connectionString) return;
    root = await mkdtemp(join(tmpdir(), "artflow-archive-service-"));
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    await migrate(db);
  });

  afterAll(async () => {
    if (!connectionString) return;
    await closeDb(db);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
    await rm(root, { recursive: true, force: true });
  });

  it("refuses to archive while a grouping stage is not frozen or cancelled", async () => {
    const activityId = await seed({ capabilities: ["publishing", "archive", "grouping"] });
    await insertGroupingStage(db, {
      id: "grouping-archive-stage",
      activityId,
      stageKey: "chorus",
      name: "分组合唱",
      status: "draft",
      rosterSource: "all_approved",
      sourceFingerprint: "",
      materialWindow: "closed",
      cancelReason: "",
      revision: 1,
    }, "2026-10-27T10:00:00Z");
    await expect(
      archiveActivity(db, deps(), {
        commandId: "archive-grouping-open",
        activityId,
        expectedRevision: 1,
        note: "活动结束归档",
      }),
    ).rejects.toMatchObject({ code: "ARCHIVE_GROUPING_NOT_FROZEN" });
  });

  it("includes frozen grouping data in the archive package", async () => {
    const activityId = await seed({ capabilities: ["publishing", "archive", "grouping"] });
    const stageId = "grouping-archive-frozen";
    await insertGroupingStage(db, {
      id: stageId,
      activityId,
      stageKey: "chorus",
      name: "分组合唱",
      status: "frozen",
      rosterSource: "all_approved",
      sourceFingerprint: "fingerprint",
      materialWindow: "open",
      cancelReason: "",
      confirmedAt: "2026-10-27T10:00:00Z",
      confirmedBy: "staff",
      frozenAt: "2026-10-27T10:01:00Z",
      frozenBy: "staff",
      revision: 3,
    }, "2026-10-27T10:00:00Z");
    await db.insertInto("grouping_group").values({
      id: "grouping-archive-group",
      stage_id: stageId,
      group_order: 1,
      name: "A 组",
      is_active: true,
      created_at: new Date(),
      updated_at: new Date(),
    }).execute();
    await db.insertInto("grouping_membership").values({
      id: "grouping-archive-member",
      stage_id: stageId,
      group_id: "grouping-archive-group",
      participant_id: "p1",
      is_current: true,
      joined_at: new Date(),
      left_at: null,
      removed_by: null,
      reason: "",
    }).execute();

    await archiveActivity(db, deps(), {
      commandId: "archive-grouping-frozen",
      activityId,
      expectedRevision: 1,
      note: "活动结束归档",
    });
    const file = await readArchiveFile(db, deps(), { activityId });
    const entries = unzipSync(file.bytes);
    expect(Object.keys(entries)).toContain("grouping.json");
    expect(strFromU8(entries["grouping.json"] ?? new Uint8Array())).toContain("A 组");
    expect(strFromU8(entries["grouping.csv"] ?? new Uint8Array())).toContain("p1");
  });

  it("archives a closed activity and serves a verified ZIP", async () => {
    const activityId = await seed({ sessions: true });
    const archived = await archiveActivity(db, deps(), {
      commandId: "archive-once",
      activityId,
      expectedRevision: 1,
      note: "活动结束归档",
    });
    expect(archived.body.summary).toMatchObject({
      activityPhase: "archived",
      activityInfoTitle: "2026 院十佳",
      releaseRows: [
        {
          release: `release-${activityId}`,
          snapshotAvailable: true,
          snapshotActivityTitle: "2026 院十佳",
          snapshotPublicTitle: "2026 院十佳 · 正式赛果",
        },
      ],
    });
    expect(archived.body.package).toMatchObject({ version: 1, isCurrent: true, sizeBytes: expect.any(Number) });
    const state = await getArchiveState(db, deps(), { activityId });
    expect(state.activity.status).toBe("archived");
    expect(state.packages).toHaveLength(1);
    expect("key" in state.packages[0]!).toBe(false);

    const file = await readArchiveFile(db, deps(), { activityId });
    const entries = unzipSync(file.bytes);
    expect(Object.keys(entries)).toContain("manifest.json");
    expect(strFromU8(entries["activity.json"] ?? new Uint8Array())).toContain('"status": "archived"');
    expect(strFromU8(entries["sessions.json"] ?? new Uint8Array())).toContain("session-formal");
    expect(strFromU8(entries["sessions.json"] ?? new Uint8Array())).not.toContain("session-rehearsal");

    const events = await readEventsSince(db, { activityId, after: 0, limit: 100 });
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["ArchivePackaged", "ActivityArchived"]),
    );
    const audits = await db.selectFrom("audit_entry").select(["command_id"]).where("activity_id", "=", activityId).execute();
    expect(audits.map((row) => row.command_id)).toContain("archive-once");
  });

  it("fails closed without an active release or with an open vote session", async () => {
    const noRelease = await seed({ withRelease: false });
    await expect(archiveActivity(db, deps(), {
      commandId: "archive-no-release",
      activityId: noRelease,
      expectedRevision: 1,
      note: "no release",
    })).rejects.toMatchObject({ code: "ARCHIVE_RESULT_NOT_RELEASED" });
    const openVote = await seed({ capabilities: ["archive", "voting"], voteOpen: true });
    // Re-seed without publishing but with an open vote session.
    await expect(archiveActivity(db, deps(), {
      commandId: "archive-open-vote",
      activityId: openVote,
      expectedRevision: 1,
      note: "open vote",
    })).rejects.toMatchObject({ code: "ARCHIVE_VOTE_SESSION_OPEN" });
  });

  it("unarchives, demotes the package, and re-archives as version 2", async () => {
    const activityId = await seed();
    const first = await archiveActivity(db, deps(), {
      commandId: "archive-first",
      activityId,
      expectedRevision: 1,
      note: "first",
    });
    const unarchived = await unarchiveActivity(db, deps(), {
      commandId: "unarchive-first",
      activityId,
      expectedRevision: 2,
      note: "unarchive",
    });
    expect(unarchived.body.activity.status).toBe("closed");
    expect(unarchived.body.demotedPackageId).toBe(first.body.package.id);
    const second = await archiveActivity(db, deps(), {
      commandId: "archive-second",
      activityId,
      expectedRevision: 3,
      note: "second",
    });
    expect(second.body.package.version).toBe(2);
    const state = await getArchiveState(db, deps(), { activityId });
    expect(state.packages.map((item) => item.version)).toEqual([2, 1]);
    expect(state.packages.filter((item) => item.isCurrent)).toHaveLength(1);
  });

  it("detects a tampered package file", async () => {
    const activityId = await seed();
    await archiveActivity(db, deps(), {
      commandId: "archive-tamper",
      activityId,
      expectedRevision: 1,
      note: "tamper",
    });
    const storage = createLocalArchiveStorage(root);
    await storage.put(`${activityId}/v1.zip`, new Uint8Array([1, 2, 3]));
    await expect(readArchiveFile(db, deps(), { activityId })).rejects.toMatchObject({
      code: "ARCHIVE_INTEGRITY_FAILED",
    });
  });

  it("serializes two concurrent archives through the Activity lock", async () => {
    const activityId = await seed();
    const other = createDb({ connectionString: connectionString ?? "", schema });
    try {
      const results = await Promise.allSettled([
        archiveActivity(db, deps(), {
          commandId: "archive-race-a",
          activityId,
          expectedRevision: 1,
          note: "a",
        }),
        archiveActivity(other, deps(), {
          commandId: "archive-race-b",
          activityId,
          expectedRevision: 1,
          note: "b",
        }),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    } finally {
      await closeDb(other);
    }
  });
});
