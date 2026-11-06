import { randomUUID } from "node:crypto";

import { closeDb, createDb, migrate, readActivityAnalytics } from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import { Client } from "pg";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_analytics_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;

describe.skipIf(!connectionString)("activity analytics repository", () => {
  beforeAll(async () => {
    if (connectionString === undefined) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    await migrate(db);

    await db.insertInto("activity").values({
      id: "analytics-activity",
      public_code: "ANALYTICS-1",
      title: "运营分析测试",
      status: "closed",
      revision: 3,
      enabled_capabilities: JSON.stringify(["registration", "materials", "competition", "voting", "publishing"]),
      active_definition_version: 1,
    }).execute();
    await db.insertInto("registration").values([
      {
        id: "registration-1",
        activity_id: "analytics-activity",
        participant_id: "participant-1",
        questionnaire_version: "v1",
        questionnaire_hash: "q-hash",
        status: "submitted",
        answers: JSON.stringify({ private: "must-not-leak" }),
        revision: 1,
      },
      {
        id: "registration-2",
        activity_id: "analytics-activity",
        participant_id: "participant-2",
        questionnaire_version: "v1",
        questionnaire_hash: "q-hash",
        status: "approved",
        answers: JSON.stringify({ private: "must-not-leak" }),
        revision: 2,
      },
    ]).execute();
    await db.insertInto("roster").values({
      activity_id: "analytics-activity",
      status: "unknown",
      revision: 1,
    }).execute();
    await db.insertInto("material_check").values([
      { id: "check-1", activity_id: "analytics-activity", registration_id: "registration-1", slot_key: "audio", item_name: "音频", purpose: "audio", accepted_purposes: JSON.stringify(["audio"]), status: "missing", required: true, review_note: "", revision: 0 },
      { id: "check-2", activity_id: "analytics-activity", registration_id: "registration-2", slot_key: "lyric", item_name: "歌词", purpose: "document", accepted_purposes: JSON.stringify(["document"]), status: "approved", required: true, review_note: "", revision: 1 },
      { id: "check-3", activity_id: "analytics-activity", registration_id: "registration-2", slot_key: "photo", item_name: "照片", purpose: "image", accepted_purposes: JSON.stringify(["image"]), status: "needs_supplement", required: false, review_note: "", revision: 0 },
    ]).execute();
    await db.insertInto("competition_round").values([
      { id: "round-1", activity_id: "analytics-activity", round_key: "prelim", release_version: 1, state: "locked", revision: 3, score_version: 1, minimum_judges: 2, judge_count: 3, completion_mode: "all", scoring_method: "weighted", advance_count: 1, locked_at: "2026-10-28T10:00:00Z" },
      { id: "round-2", activity_id: "analytics-activity", round_key: "final", release_version: 1, state: "scoring", revision: 2, score_version: 0, minimum_judges: 2, judge_count: 3, completion_mode: "all", scoring_method: "weighted", advance_count: 1 },
    ]).execute();
    await db.insertInto("performance").values({
      id: "performance-1",
      activity_id: "analytics-activity",
      round_id: "round-2",
      contestant_id: "participant-2",
      sequence: 1,
      state: "open",
      context_version: 1,
    }).execute();
    await db.insertInto("vote_session").values([
      {
        id: "vote-1",
        activity_id: "analytics-activity",
        definition_version: 1,
        mode: "formal",
        purpose: "popularity",
        selection_type: "single",
        max_selections: 1,
        identity_policy: "ticket",
        scoring_rule: JSON.stringify({}),
        status: "open",
        revision: 1,
      },
      {
        id: "vote-2",
        activity_id: "analytics-activity",
        definition_version: 1,
        mode: "formal",
        purpose: "popularity",
        selection_type: "single",
        max_selections: 1,
        identity_policy: "anonymous",
        scoring_rule: JSON.stringify({}),
        status: "closed",
        revision: 2,
      },
    ]).execute();
    await db.insertInto("ticket").values([
      {
        id: "ticket-valid",
        activity_id: "analytics-activity",
        public_code: "TICKET-VALID",
        credential_digest: "valid-digest",
        credential_version: 1,
        state: "redeemed",
        issued_at: "2026-10-28T10:00:00Z",
      },
      {
        id: "ticket-revoked",
        activity_id: "analytics-activity",
        public_code: "TICKET-REVOKED",
        credential_digest: "revoked-digest",
        credential_version: 1,
        state: "revoked",
        issued_at: "2026-10-28T10:00:00Z",
      },
    ]).execute();
    await db.insertInto("ballot").values([
      { id: "ballot-valid", activity_id: "analytics-activity", session_id: "vote-1", identity_type: "ticket", ticket_id: "ticket-valid", submitted_at: "2026-10-28T10:00:00Z" },
      { id: "ballot-revoked", activity_id: "analytics-activity", session_id: "vote-1", identity_type: "ticket", ticket_id: "ticket-revoked", submitted_at: "2026-10-28T10:01:00Z" },
    ]).execute();
    await db.insertInto("stage_result").values([
      { id: "stage-confirmed", activity_id: "analytics-activity", stage_key: "final", status: "confirmed", candidate_revision: 1, source_candidate_revision: 1, input_fingerprint: "fingerprint-1", decisions: JSON.stringify([]), awards: JSON.stringify([]), note: "", revision: 1, confirmed_at: "2026-10-28T11:00:00Z" },
      { id: "stage-ready", activity_id: "analytics-activity", stage_key: "popularity", status: "ready_to_confirm", candidate_revision: 1, source_candidate_revision: 1, input_fingerprint: "fingerprint-2", decisions: JSON.stringify([]), awards: JSON.stringify([]), note: "", revision: 1 },
    ]).execute();
    await db.insertInto("result_publication").values({
      id: "publication-1",
      activity_id: "analytics-activity",
      stage_key: "final",
      title: "最终结果",
      content: "content",
      version: 1,
      revision: 1,
    }).execute();
    await db.insertInto("result_release").values({
      id: "release-1",
      activity_id: "analytics-activity",
      publication_id: "publication-1",
      stage_result_id: "stage-confirmed",
      stage_key: "final",
      status: "active",
      snapshot: JSON.stringify({}),
      snapshot_candidate_revision: 1,
      result_version: 1,
      post_version: 1,
      input_fingerprint: "fingerprint-1",
      note: "",
      released_at: "2026-10-28T11:30:00Z",
      revision: 1,
    }).execute();
    await db.insertInto("archive_package").values([
      { id: "archive-1", activity_id: "analytics-activity", version: 1, key: "archive-1.zip", size_bytes: 10, sha256: "a".repeat(64), manifest: JSON.stringify({}), summary: JSON.stringify({}), note: "", sealed_at: "2026-10-28T12:00:00Z", sealed_by: "staff", is_current: false },
      { id: "archive-2", activity_id: "analytics-activity", version: 2, key: "archive-2.zip", size_bytes: 10, sha256: "b".repeat(64), manifest: JSON.stringify({}), summary: JSON.stringify({}), note: "", sealed_at: "2026-10-28T12:01:00Z", sealed_by: "staff", is_current: true },
    ]).execute();
  });

  afterAll(async () => {
    if (connectionString === undefined) return;
    await closeDb(db);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("returns cross-capability aggregates without exposing row-level facts", async () => {
    const report = await readActivityAnalytics(db, "analytics-activity");

    expect(report.registration).toEqual({ total: 2, byStatus: { approved: 1, submitted: 1 } });
    expect(report.materialChecks).toEqual({
      total: 3,
      byStatus: { approved: 1, missing: 1, needs_supplement: 1 },
      requiredNotApproved: 1,
    });
    expect(report.roster).toEqual({ status: "unknown", approvedCount: null, revision: 1 });
    expect(report.competition).toMatchObject({
      rounds: { total: 2, byState: { locked: 1, scoring: 1 }, locked: 1 },
      performances: { total: 1, byState: { open: 1 }, locked: 0 },
      scoreFacts: { total: 0, current: 0 },
    });
    expect(report.voting).toEqual({ sessions: { total: 2, byStatus: { closed: 1, open: 1 } }, validBallots: 1 });
    expect(report.publishing).toEqual({
      stageResults: {
        total: 2,
        byStatus: { confirmed: 1, ready_to_confirm: 1 },
        stale: 0,
        confirmedWithoutActiveRelease: 0,
      },
      resultReleases: { total: 1, byStatus: { active: 1 } },
    });
    expect(report.archive).toEqual({ totalPackages: 2, currentPackages: 1 });
    expect(JSON.stringify(report)).not.toContain("must-not-leak");
    expect(JSON.stringify(report)).not.toContain("participant-1");
  });

  it("returns zero-safe aggregates for an activity with no facts", async () => {
    const id = `empty-${randomUUID()}`;
    await db.insertInto("activity").values({
      id,
      public_code: `EMPTY-${randomUUID().slice(0, 8)}`,
      title: "空活动",
      status: "draft",
      revision: 0,
      enabled_capabilities: JSON.stringify([]),
      active_definition_version: 1,
    }).execute();
    const report = await readActivityAnalytics(db, id);

    expect(report.registration.total).toBe(0);
    expect(report.voting.validBallots).toBe(0);
    expect(report.archive).toEqual({ totalPackages: 0, currentPackages: 0 });
  });
});
