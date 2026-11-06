import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  closeDb,
  createDb,
  insertResultPublication,
  insertResultRelease,
  insertStageResult,
  migrate,
  readEventsSince,
} from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import type { ActorContext } from "@artflow-plus/domain";
import { Client } from "pg";
import { strFromU8, unzipSync } from "fflate";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { archiveActivity, readArchiveFile, renameActivity } from "../src/index.js";
import type { RuntimeDeps } from "../src/index.js";
import { createLocalArchiveStorage } from "../src/archive-storage.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const fixture = JSON.parse(
  readFileSync(resolve(process.cwd(), "../../../", "tests/golden/archive-identity.json"), "utf8"),
) as {
  readonly id: string;
  readonly invariants: readonly string[];
  readonly steps: readonly {
    readonly command: string;
    readonly input: Record<string, unknown>;
    readonly expect: { readonly outcome: string; readonly reason?: string; readonly events?: readonly string[] };
  }[];
};
const schema = `artflow_golden_m7b_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;
let root: string;
let tick = 0;

const staff: ActorContext = {
  actorId: "fixture-admin",
  actorType: "user",
  roles: ["admin"],
  permissions: ["archive.manage", "studio.manage"],
};

function deps(): RuntimeDeps {
  return {
    actor: staff,
    now: () => new Date(Date.UTC(2026, 9, 20, 12, 0, tick++)).toISOString(),
    newEventId: () => `golden-m7b-${randomUUID()}`,
    archiveStorage: createLocalArchiveStorage(root),
  };
}

const snapshot = {
  activityTitle: "2026 院十佳",
  publicTitle: "2026 院十佳 · 正式赛果",
  stageKey: "final_podium",
  decisions: [{ rank: 1, contestantId: "singer-a", score: "98.30" }],
  awards: [{ award: "冠军", contestantId: "singer-a" }],
};

async function seed(): Promise<string> {
  const activityId = "act-2026";
  await db.insertInto("activity").values({
    id: activityId,
    public_code: "ABC123",
    title: "2026 院十佳",
    status: "closed",
    revision: 1,
    enabled_capabilities: JSON.stringify(["publishing", "archive"]),
    active_definition_version: 1,
  }).execute();
  await insertStageResult(db, {
    id: "stage-final",
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
    confirmedAt: "2026-10-19T17:00:00.000Z",
  });
  await insertResultPublication(db, {
    id: "publication-final",
    activityId,
    stageKey: "final_podium",
    title: "编辑标题",
    content: "",
    version: 1,
    revision: 0,
  });
  await insertResultRelease(db, {
    id: "release-1",
    activityId,
    publicationId: "publication-final",
    stageResultId: "stage-final",
    stageKey: "final_podium",
    status: "active",
    snapshot,
    snapshotCandidateRevision: 3,
    resultVersion: 3,
    postVersion: 1,
    inputFingerprint: "fp-1",
    note: "正式发布",
    releasedAt: "2026-10-19T18:00:00.000Z",
    revision: 0,
  });
  await insertResultRelease(db, {
    id: "release-legacy",
    activityId,
    publicationId: "publication-final",
    stageResultId: "stage-final",
    stageKey: "final_podium",
    status: "superseded",
    snapshot: null,
    snapshotCandidateRevision: 2,
    resultVersion: 2,
    postVersion: 1,
    inputFingerprint: "fp-legacy",
    note: "legacy",
    releasedAt: "2026-10-19T19:00:00.000Z",
    supersededAt: "2026-10-19T19:30:00.000Z",
    revision: 1,
  });
  return activityId;
}

function step(index: number) {
  const value = fixture.steps[index];
  if (value === undefined) throw new Error(`Golden step ${index} is missing.`);
  return value;
}

describe.skipIf(!connectionString)("archive-identity golden", () => {
  beforeAll(async () => {
    if (!connectionString) return;
    root = await mkdtemp(join(tmpdir(), "artflow-golden-archive-"));
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

  it("consumes the fixture through real Plus commands", async () => {
    expect(fixture.id).toBe("archive-identity");
    expect(fixture.invariants).toEqual(expect.arrayContaining(["RES-06", "RES-07", "LIFE-05"]));
    const activityId = await seed();

    const renameStep = step(0);
    await renameActivity(db, deps(), {
      commandId: "golden-rename",
      activityId,
      title: String(renameStep.input.title),
      expectedRevision: 1,
    });

    const archiveStep = step(1);
    const archived = await archiveActivity(db, deps(), {
      commandId: "golden-archive",
      activityId,
      expectedRevision: 2,
      note: String(archiveStep.input.reason),
    });
    expect(archiveStep.expect.outcome).toBe("accepted");
    expect(archived.body.summary.activityPhase).toBe("archived");
    expect(archived.body.summary.activityInfoTitle).toBe("渡梦十佳");
    expect(archived.body.summary.releaseRows).toEqual([
      {
        release: "release-1",
        snapshotAvailable: true,
        snapshotActivityTitle: "2026 院十佳",
        snapshotPublicTitle: "2026 院十佳 · 正式赛果",
      },
      {
        release: "release-legacy",
        snapshotAvailable: false,
        snapshotActivityTitle: null,
        snapshotPublicTitle: null,
      },
    ]);
    expect(archived.body.summary.excludedFields).toEqual(
      expect.arrayContaining(["input_fingerprint", "authority_hash"]),
    );

    const file = await readArchiveFile(db, deps(), { activityId });
    const entries = unzipSync(file.bytes);
    const activityJson = JSON.parse(strFromU8(entries["activity.json"] ?? new Uint8Array())) as {
      title: string;
      status: string;
    };
    expect(activityJson).toMatchObject({ title: "渡梦十佳", status: "archived" });
    const releasesJson = JSON.parse(strFromU8(entries["releases.json"] ?? new Uint8Array())) as {
      releaseId: string;
      snapshot: { activityTitle: string; publicTitle: string } | null;
    }[];
    expect(releasesJson.find((item) => item.releaseId === "release-1")?.snapshot).toMatchObject({
      activityTitle: "2026 院十佳",
      publicTitle: "2026 院十佳 · 正式赛果",
    });
    expect(releasesJson.find((item) => item.releaseId === "release-legacy")?.snapshot).toBeNull();
    const allText = Object.values(entries).map((bytes) => strFromU8(bytes)).join("\n");
    expect(allText).not.toContain("fp-1");
    expect(allText).not.toContain("fp-legacy");

    const modifyStep = step(2);
    await expect(renameActivity(db, deps(), {
      commandId: "golden-modify-archived",
      activityId,
      title: String(modifyStep.input.title),
      expectedRevision: 3,
    })).rejects.toMatchObject({ code: modifyStep.expect.reason ?? "ACTIVITY_ARCHIVED" });
    const after = await db.selectFrom("activity").select(["title", "revision", "status"]).where("id", "=", activityId).executeTakeFirstOrThrow();
    expect(after).toMatchObject({ title: "渡梦十佳", revision: 3, status: "archived" });

    const events = (await readEventsSince(db, { activityId, after: 0, limit: 100 })).map((event) => event.type);
    expect(events).toEqual(
      expect.arrayContaining(["ActivityRenamed", "ArchivePackaged", "ActivityArchived"]),
    );
  });
});
