import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  closeDb,
  createDb,
  insertPodiumCandidate,
  insertRelease,
  insertSession,
  migrate,
  readEventsSince,
  selectPublicResults,
} from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import type { ActorContext, ExecutionSession } from "@artflow-plus/domain";
import { Client } from "pg";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  confirmStageResult,
  editPublication,
  getPublishingState,
  releaseResult,
  revokeResultRelease,
  unlockStageResult,
} from "../src/index.js";
import type { RuntimeDeps } from "../src/index.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const fixture = JSON.parse(
  readFileSync(resolve(process.cwd(), "../../../", "tests/golden/result-release-lifecycle.json"), "utf8"),
) as {
  readonly id: string;
  readonly invariants: readonly string[];
  readonly facts: {
    readonly stage_result: {
      readonly candidate_revision: number;
      readonly input_fingerprint: string;
      readonly decisions: readonly { rank: number; contestant: string; score: string }[];
      readonly awards: readonly { award: string; contestant: string }[];
    };
    readonly activity: { readonly title: string };
  };
  readonly steps: readonly {
    readonly command: string;
    readonly input: Record<string, unknown>;
    readonly expect: {
      readonly outcome: string;
      readonly reason?: string;
      readonly events?: readonly string[];
      readonly read_model?: Record<string, unknown>;
    };
  }[];
};
const schema = `artflow_golden_m7_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;
let tick = 0;

const staff: ActorContext = {
  actorId: "fixture-admin",
  actorType: "user",
  roles: ["admin"],
  permissions: ["result.manage"],
};

function deps(): RuntimeDeps {
  return {
    actor: staff,
    now: () => new Date(Date.UTC(2026, 9, 19, 20, 0, tick++)).toISOString(),
    newEventId: () => `golden-m7-${randomUUID()}`,
  };
}

async function seed(): Promise<string> {
  const activityId = "act-2026";
  await db.insertInto("activity").values({
    id: activityId,
    public_code: "ABC123",
    title: fixture.facts.activity.title,
    status: "active",
    revision: 1,
    enabled_capabilities: JSON.stringify(["competition", "publishing"]),
    active_definition_version: 1,
  }).execute();
  await insertRelease(db, {
    activityId,
    version: 1,
    contentHash: "m7-release",
    capabilities: {
      publishing: {
        ok: true,
        capabilityKey: "publishing",
        contentHash: "publishing",
        artifact: { version: 1, schemaVersion: 1, stages: [{ key: "final_podium", label: "正式赛果" }] },
      },
    },
    executionPolicy: { declaredScopes: ["publishing"], conflicts: {}, runtimeContractVersion: 1 },
    capabilityVersions: { publishing: "1" },
    bindings: [],
    releasedAt: "2026-10-19T17:00:00Z",
    sourceDraftRevision: 1,
  });
  const session: ExecutionSession = {
    id: "execution-act-2026",
    activityId,
    definitionVersion: 1,
    contentHash: "m7-release",
    scope: "publishing",
    mode: "formal",
    status: "running",
    revision: 0,
  };
  await insertSession(db, session, "2026-10-19T17:00:00Z");
  await insertPodiumCandidate(db, {
    id: "podium-act-2026",
    activityId,
    inputFingerprint: fixture.facts.stage_result.input_fingerprint,
    status: "candidate",
    placements: fixture.facts.stage_result.decisions.map((decision) => ({
      place: decision.rank,
      contestantId: decision.contestant,
      total: decision.score,
    })),
    sourceRoundIds: ["round-final"],
    sourceScoreVersions: [{ roundId: "round-final", sourceScoreVersion: 1 }],
    revision: fixture.facts.stage_result.candidate_revision,
  });
  return activityId;
}

function step(index: number) {
  const value = fixture.steps[index];
  if (value === undefined) throw new Error(`Golden step ${index} is missing.`);
  return value;
}

describe.skipIf(!connectionString)("result-release-lifecycle golden", () => {
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

  it("consumes the fixture through real Plus commands", async () => {
    expect(fixture.id).toBe("result-release-lifecycle");
    expect(fixture.invariants).toEqual(expect.arrayContaining(["RES-01", "RES-02", "RES-03", "RES-04"]));
    const activityId = await seed();
    const facts = fixture.facts.stage_result;
    await confirmStageResult(db, deps(), {
      commandId: "golden-confirm",
      activityId,
      stageKey: "final_podium",
      scope: "publishing",
      expectedSourceRevision: facts.candidate_revision,
      expectedInputFingerprint: facts.input_fingerprint,
      awards: facts.awards.map((award) => ({ award: award.award, contestantId: award.contestant })),
      note: "fixture confirm",
    });

    const releaseStep = step(0);
    const released = await releaseResult(db, deps(), {
      commandId: "golden-release-1",
      activityId,
      stageKey: "final_podium",
      scope: "publishing",
      expectedCandidateRevision: Number(releaseStep.input.expected_candidate_revision),
      note: String(releaseStep.input.note),
    });
    expect(releaseStep.expect.outcome).toBe("accepted");
    expect(released.body.snapshot).toMatchObject({
      publicTitle: "2026 院十佳 · 正式赛果",
    });
    expect(released.body.snapshot.decisions).toHaveLength(2);
    expect(released.body.inputFingerprint).toBe("fp-1");

    const editStep = step(1);
    await expect(editPublication(db, deps(), {
      commandId: "golden-edit",
      activityId,
      stageKey: "final_podium",
      scope: "publishing",
      expectedVersion: 1,
      title: String(editStep.input.editorial_title),
      content: "",
    })).rejects.toMatchObject({ code: editStep.expect.reason ?? "RESULT_POST_FROZEN" });
    expect((await getPublishingState(db, deps(), { activityId })).releases).toHaveLength(1);

    const revokeStep = step(2);
    const revoked = await revokeResultRelease(db, deps(), {
      commandId: "golden-revoke",
      activityId,
      releaseId: released.body.id,
      scope: "publishing",
      note: String(revokeStep.input.note),
    });
    expect(revoked.body.status).toBe("revoked");
    expect((await selectPublicResults(db, "ABC123"))?.results).toEqual([]);

    const reReleaseStep = step(3);
    const reReleased = await releaseResult(db, deps(), {
      commandId: "golden-release-2",
      activityId,
      stageKey: "final_podium",
      scope: "publishing",
      expectedCandidateRevision: Number(reReleaseStep.input.expected_candidate_revision),
      note: String(reReleaseStep.input.note),
    });
    expect(reReleased.body.status).toBe("active");
    expect((await getPublishingState(db, deps(), { activityId })).releases).toHaveLength(2);
    expect((await selectPublicResults(db, "ABC123"))?.results).toHaveLength(1);

    const unlockStep = step(4);
    const unlocked = await unlockStageResult(db, deps(), {
      commandId: "golden-unlock",
      activityId,
      stageKey: "final_podium",
      scope: "publishing",
      expectedCandidateRevision: Number(unlockStep.input.expected_candidate_revision),
      note: String(unlockStep.input.note),
    });
    expect(unlocked.body).toMatchObject({ status: "ready_to_confirm", candidateRevision: 4 });
    expect((await selectPublicResults(db, "ABC123"))?.results).toEqual([]);
    const events = (await readEventsSince(db, { activityId, after: 0, limit: 100 })).map((event) => event.type);
    expect(events).toEqual(
      expect.arrayContaining([
        "StageResultConfirmed",
        "ResultReleased",
        "ResultReleaseRevoked",
        "ResultReleaseSuperseded",
        "StageResultUnlocked",
      ]),
    );
  });
});
