import { randomUUID } from "node:crypto";

import type { Kysely } from "kysely";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closeDb,
  createDb,
  demoteCurrentArchivePackages,
  getArchivePackage,
  getCurrentArchivePackage,
  insertArchivePackage,
  listArchivePackages,
  maxArchiveVersion,
  migrate,
} from "../src/index.js";
import type { Database } from "../src/index.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_archive_repository_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;

const manifest = {
  schemaVersion: 1 as const,
  packageId: "archive-1",
  activityId: "act",
  version: 1,
  sealedAt: "2026-10-20T00:00:00.000Z",
  sealedBy: "staff",
  format: "zip-json-csv" as const,
  artifacts: [],
  excludedFields: ["input_fingerprint", "authority_hash"],
  counts: { releases: 0, stageResults: 0, sessions: 0, events: 0 },
};
const summary = {
  activityPhase: "archived" as const,
  activityInfoTitle: "2026 院十佳",
  releaseRows: [],
  excludedFields: ["input_fingerprint", "authority_hash"],
};

async function seed(activityId: string): Promise<void> {
  await db.insertInto("activity").values({
    id: activityId,
    public_code: activityId,
    title: "2026 院十佳",
    status: "archived",
    revision: 2,
    enabled_capabilities: JSON.stringify(["archive"]),
    active_definition_version: 1,
  }).execute();
}

function packageRow(activityId: string, version: number, current: boolean) {
  return {
    id: `archive-${activityId}-${version}`,
    activityId,
    version,
    key: `${activityId}/v${version}.zip`,
    sizeBytes: 100 + version,
    sha256: "a".repeat(64),
    manifest: { ...manifest, activityId, version },
    summary,
    note: "archive",
    sealedAt: "2026-10-20T00:00:00.000Z",
    sealedBy: "staff",
    isCurrent: current,
  };
}

describe.skipIf(!connectionString)("archive repository", () => {
  beforeAll(async () => {
    if (!connectionString) return;
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
  });

  it("stores versions and keeps exactly one current package", async () => {
    const activityId = `act-${randomUUID()}`;
    await seed(activityId);
    await insertArchivePackage(db, packageRow(activityId, 1, true));
    expect(await getCurrentArchivePackage(db, activityId)).toMatchObject({ version: 1, isCurrent: true });
    expect(await maxArchiveVersion(db, activityId)).toBe(1);
    await demoteCurrentArchivePackages(db, activityId);
    await insertArchivePackage(db, packageRow(activityId, 2, true));
    expect(await getCurrentArchivePackage(db, activityId)).toMatchObject({ version: 2, isCurrent: true });
    expect(await maxArchiveVersion(db, activityId)).toBe(2);
    expect((await listArchivePackages(db, activityId)).map((item) => item.version)).toEqual([2, 1]);
    expect(await getArchivePackage(db, activityId, 1)).toMatchObject({ version: 1, isCurrent: false });
  });

  it("rejects a second current package", async () => {
    const activityId = `act-${randomUUID()}`;
    await seed(activityId);
    await insertArchivePackage(db, packageRow(activityId, 1, true));
    await expect(insertArchivePackage(db, packageRow(activityId, 2, true))).rejects.toThrow(
      /archive_package_current_key/,
    );
  });

  it("isolates activities", async () => {
    const first = `act-${randomUUID()}`;
    const second = `act-${randomUUID()}`;
    await seed(first);
    await seed(second);
    await insertArchivePackage(db, packageRow(first, 1, true));
    expect(await getCurrentArchivePackage(db, second)).toBeNull();
    expect(await listArchivePackages(db, second)).toEqual([]);
  });
});
