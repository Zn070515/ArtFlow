import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  closeDb,
  createDb,
  getRegistration,
  listMaterials,
  listMaterialChecks,
  migrate,
} from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import { defaultCapabilityRegistry, SINGER_COMPETITION_PACK } from "@artflow-plus/domain";
import type { ActorContext } from "@artflow-plus/domain";
import type { Kysely } from "kysely";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  adoptLegacyBundle,
  attachMaterialContent,
  createLocalMaterialStorage,
  getSupplementContext,
  issueSupplementGrant,
  readMaterialContent,
  reviewMaterial,
  submitSupplement,
  uploadMaterial,
  uploadSupplementMaterial,
} from "../src/index.js";
import type { RuntimeDeps } from "../src/index.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_material_cutover_${Date.now()}_${process.pid}`;
const source = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/legacy-bundle.json", import.meta.url)), "utf8"),
) as Record<string, unknown>;

const audioBytes = new TextEncoder().encode("audio-bytes");
const bundle: Record<string, unknown> = {
  ...source,
  activity: { ...(source.activity as Record<string, unknown>), publicCode: "MAT-1" },
  source: { ...(source.source as Record<string, unknown>), publicCode: "MAT-1" },
  materials: [{
    legacyId: 501,
    registrationLegacyId: 101,
    questionKey: "audio",
    originalName: "伴奏.mp3",
    contentType: "audio/mpeg",
    byteLength: audioBytes.byteLength,
    storagePath: "submissions/伴奏.mp3",
    status: "approved",
    reviewNote: "ok",
    createdAt: "2025-10-02T00:00:00Z",
  }],
  materialChecks: [
    {
      legacyId: 601,
      registrationLegacyId: 101,
      questionKey: "audio",
      itemName: "伴奏",
      filePurpose: "audio",
      acceptedFilePurposes: ["audio"],
      status: "approved",
      required: true,
      reviewNote: "ok",
      sortOrder: 1,
    },
    {
      legacyId: 602,
      registrationLegacyId: 101,
      questionKey: "lyric",
      itemName: "歌词",
      filePurpose: "document",
      acceptedFilePurposes: ["document"],
      status: "needs_supplement",
      required: true,
      reviewNote: "请补充歌词文件",
      sortOrder: 2,
    },
  ],
  counts: { ...(source.counts as Record<string, unknown>), materials: 1, materialChecks: 2 },
  competition: {
    ...(source.competition as Record<string, unknown>),
    panels: [],
    seats: [],
    performances: [],
    scores: [],
    rankings: [],
  },
  voting: { ...(source.voting as Record<string, unknown>), sessions: [], ballots: [] },
  results: { ...(source.results as Record<string, unknown>), stageResults: [], releases: [] },
};

let db: Kysely<Database>;
let admin: Client;
let mediaRoot = "";
let legacyRoot = "";
const staff: ActorContext = {
  actorId: "material-staff",
  actorType: "user",
  roles: ["admin"],
  permissions: [
    "registration.manage",
    "registration.review",
    "materials.manage",
    "materials.review",
    "materials.read",
    "result.manage",
    "voting.manage",
    "ticketing.manage",
  ],
};

function deps(): RuntimeDeps {
  return {
    actor: staff,
    now: () => new Date().toISOString(),
    newEventId: () => crypto.randomUUID(),
    materialStorage: createLocalMaterialStorage({ root: mediaRoot, legacyRoot }),
  };
}

describe.skipIf(!connectionString)("material cutover", () => {
  beforeAll(async () => {
    if (!connectionString) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    await migrate(db);
    mediaRoot = await mkdtemp(join(tmpdir(), "artflow-media-"));
    legacyRoot = await mkdtemp(join(tmpdir(), "artflow-legacy-"));
    await mkdir(join(legacyRoot, "submissions"), { recursive: true });
    await writeFile(join(legacyRoot, "submissions", "伴奏.mp3"), audioBytes);
  });

  afterAll(async () => {
    if (!connectionString) return;
    await closeDb(db);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("adopts missing material checks and serves the legacy bytes", async () => {
    const result = await adoptLegacyBundle(db, deps(), {
      commandId: "material-adopt",
      bundle,
      dryRun: false,
      registry: defaultCapabilityRegistry,
      pack: SINGER_COMPETITION_PACK,
      answers: { "audience-voting": true },
      enable: ["ticketing"],
    });
    expect(result.report.semanticReady, JSON.stringify(result.report.checks.filter((check) => !check.ok))).toBe(true);
    const activity = await db.selectFrom("activity").selectAll()
      .where("public_code", "=", "MAT-1").executeTakeFirstOrThrow();
    const registration = await db.selectFrom("registration").selectAll()
      .where("activity_id", "=", activity.id).executeTakeFirstOrThrow();
    const checks = await listMaterialChecks(db, registration.id);
    expect(checks.map((check) => [check.slotKey, check.status])).toEqual([
      ["audio", "approved"],
      ["lyric", "needs_supplement"],
    ]);
    const materials = await listMaterials(db, registration.id);
    expect(materials).toHaveLength(1);
    expect(materials[0]).toMatchObject({ questionKey: "audio", contentReady: true });

    const content = await readMaterialContent(db, deps(), {
      activityId: activity.id,
      materialId: materials[0]!.id,
      actor: staff,
    });
    expect(new TextDecoder().decode(content.bytes)).toBe("audio-bytes");
  });

  it("issues a supplement capability and keeps the old current on a failed replacement", async () => {
    const activity = await db.selectFrom("activity").selectAll()
      .where("public_code", "=", "MAT-1").executeTakeFirstOrThrow();
    const registration = await db.selectFrom("registration").selectAll()
      .where("activity_id", "=", activity.id).executeTakeFirstOrThrow();
    const grant = await issueSupplementGrant(db, deps(), {
      commandId: "material-supplement-issue",
      activityId: activity.id,
      registrationId: registration.id,
      allowedKeys: ["lyric"],
    });
    expect(grant.status).toBe(201);
    const grantToken = grant.body.token;
    if (grantToken === null) throw new Error("The supplement grant did not return its one-time token.");
    const grantReceipt = await db.selectFrom("command_receipt")
      .select("result")
      .where("command_id", "=", "material-supplement-issue")
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(grantReceipt.result)).not.toContain(grantToken);
    expect(grantReceipt.result).toMatchObject({ token: null });
    const grantReplay = await issueSupplementGrant(db, deps(), {
      commandId: "material-supplement-issue",
      activityId: activity.id,
      registrationId: registration.id,
      allowedKeys: ["lyric"],
    });
    expect(grantReplay.replayed).toBe(true);
    expect(grantReplay.body.token).toBeNull();
    const context = await getSupplementContext(db, grantToken, deps().now());
    expect(context.registrationId).toBe(registration.id);
    expect(context.allowedKeys).toEqual(["lyric"]);

    const lyric = new TextEncoder().encode("lyric-bytes");
    const uploaded = await uploadSupplementMaterial(db, deps(), {
      token: grantToken,
      commandId: "material-supplement-upload",
      questionKey: "lyric",
      originalName: "歌词.txt",
      contentType: "text/plain",
      bytes: lyric,
    });
    const afterUpload = await listMaterials(db, registration.id);
    expect(afterUpload.find((material) => material.questionKey === "lyric")?.contentReady).toBe(true);
    expect((await listMaterialChecks(db, registration.id))
      .find((check) => check.slotKey === "lyric")?.status).toBe("uploaded");

    const before = (await listMaterials(db, registration.id))
      .find((material) => material.questionKey === "audio")!;
    const pending = await uploadMaterial(db, deps(), {
      commandId: "material-replace-pending",
      activityId: activity.id,
      registrationId: registration.id,
      questionKey: "audio",
      originalName: "new.mp3",
      contentType: "audio/mpeg",
      byteLength: 5,
    });
    await expect(attachMaterialContent(db, deps(), {
      commandId: "material-replace-failed",
      activityId: activity.id,
      materialId: pending.body.id,
      bytes: new Uint8Array([1, 2]),
    })).rejects.toMatchObject({ code: "MATERIAL_NOT_ALLOWED" });
    const afterFailure = (await listMaterials(db, registration.id))
      .find((material) => material.questionKey === "audio")!;
    expect(afterFailure.id).toBe(before.id);
    expect(afterFailure.contentReady).toBe(true);

    await attachMaterialContent(db, deps(), {
      commandId: "material-replace-ok",
      activityId: activity.id,
      materialId: pending.body.id,
      bytes: new Uint8Array(5).fill(2),
    });
    const replaced = (await listMaterials(db, registration.id))
      .find((material) => material.questionKey === "audio")!;
    expect(replaced.id).toBe(pending.body.id);
    expect(replaced.id).not.toBe(before.id);
    await reviewMaterial(db, deps(), {
      commandId: "material-replace-review",
      activityId: activity.id,
      materialId: replaced.id,
      expectedRevision: replaced.revision,
      status: "approved",
      note: "replacement accepted",
    });

    const submitted = await submitSupplement(db, deps(), {
      token: grantToken,
      commandId: "material-supplement-submit",
    });
    expect(submitted.body.status).toBe("submitted");
    expect((await getRegistration(db, registration.id))?.status).toBe("submitted");

    // A fresh storage instance (the "restart" case) still serves both files.
    const restarted = createLocalMaterialStorage({ root: mediaRoot, legacyRoot });
    const audio = (await listMaterials(db, registration.id))
      .find((material) => material.questionKey === "audio")!;
    const lyricMaterial = (await listMaterials(db, registration.id))
      .find((material) => material.questionKey === "lyric")!;
    expect(new TextDecoder().decode(await restarted.read(audio.storageKey))).toBe("\u0002\u0002\u0002\u0002\u0002");
    expect(new TextDecoder().decode(await restarted.read(lyricMaterial.storageKey))).toBe("lyric-bytes");
  });
});
