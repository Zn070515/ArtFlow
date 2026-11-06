import { randomUUID } from "node:crypto";

import {
  closeDb,
  createDb,
  getLocalAccount,
  getParticipantClaimByDigestForUpdate,
  getParticipantIdentityLinkByActor,
  getParticipantIdentityLinkByLegacy,
  insertLocalAccount,
  insertParticipantClaim,
  insertParticipantIdentityLink,
  migrate,
  readEventsSince,
} from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import { SYSTEM_ACTOR } from "@artflow-plus/domain";
import type { ActorContext } from "@artflow-plus/domain";
import type { Kysely } from "kysely";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  consumeParticipantClaim,
  hashPassword,
  issueParticipantClaim,
  stableHash,
} from "../src/index.js";
import type { RuntimeDeps } from "../src/index.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_participant_claim_${Date.now()}_${process.pid}`;

let db: Kysely<Database>;
let admin: Client;

const staff: ActorContext = {
  actorId: "staff-participant-claim",
  actorType: "user",
  roles: ["staff"],
  permissions: ["registration.review", "registration.manage"],
};

function deps(actor: ActorContext = SYSTEM_ACTOR): RuntimeDeps {
  return {
    actor,
    now: () => "2026-11-01T00:00:00.000Z",
    newEventId: () => `evt-${randomUUID()}`,
    credentialSecret: "participant-claim-test-secret",
  };
}

async function openTestClient(): Promise<Client> {
  const client = new Client({ connectionString });
  await client.connect();
  await client.query(`set search_path to "${schema}"`);
  return client;
}

async function waitForBlockedActivityLocks(expected: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await admin.query<{ count: string }>(`
      select count(*)::text as count
        from pg_stat_activity
       where wait_event_type = 'Lock'
         and query ilike '%"activity"%'
         and query ilike '%for update%'
    `);
    if (Number(result.rows[0]?.count ?? 0) >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${expected} activity row lock waiters.`);
}

async function seedRegistration(legacyParticipantId = `legacy-user:${randomUUID()}`): Promise<{
  readonly activityId: string;
  readonly registrationId: string;
  readonly legacyParticipantId: string;
}> {
  const activityId = `act-${randomUUID()}`;
  const registrationId = `reg-${randomUUID()}`;
  await db.insertInto("activity").values({
    id: activityId,
    public_code: `CLAIM-${randomUUID().slice(0, 8)}`,
    title: "Participant claim test activity",
    status: "active",
    revision: 1,
    enabled_capabilities: JSON.stringify(["registration"]),
    active_definition_version: 1,
  }).execute();
  await db.insertInto("registration").values({
    id: registrationId,
    activity_id: activityId,
    participant_id: legacyParticipantId,
    questionnaire_version: "v1",
    questionnaire_hash: "qhash",
    status: "submitted",
    answers: JSON.stringify({ name: "Imported participant" }),
    supplement_keys: JSON.stringify([]),
    revision: 1,
    review_note: "",
    reviewed_by: null,
    created_at: new Date(),
    updated_at: new Date(),
  }).execute();
  return { activityId, registrationId, legacyParticipantId };
}

async function issueClaim(
  activityId: string,
  registrationId: string,
  commandId = `issue-${randomUUID()}`,
): Promise<{ readonly token: string; readonly commandId: string }> {
  const outcome = await issueParticipantClaim(db, deps(staff), {
    commandId,
    activityId,
    registrationId,
  });
  if (outcome.body.token === null) throw new Error("Expected a first claim response to contain a token.");
  return { token: outcome.body.token, commandId };
}

describe.skipIf(!connectionString)("participant claim service on PostgreSQL", () => {
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

  it("issues a digest-only claim for an adopted legacy registration", async () => {
    const seeded = await seedRegistration();
    const issued = await issueClaim(seeded.activityId, seeded.registrationId, "claim-issue-digest");

    expect(issued.token).toMatch(/^AF1\.CLAIM\./);
    const row = await getParticipantClaimByDigestForUpdate(db, stableHash(issued.token));
    expect(row).toMatchObject({
      id: expect.stringMatching(/^participant-claim_[a-f0-9]{24}$/),
      activityId: seeded.activityId,
      registrationId: seeded.registrationId,
      legacyParticipantId: seeded.legacyParticipantId,
    });
    expect(row?.tokenDigest).not.toContain(issued.token);
    const receipt = await db.selectFrom("command_receipt")
      .select("result")
      .where("command_id", "=", issued.commandId)
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(receipt.result)).not.toContain(issued.token);
    const events = await readEventsSince(db, { activityId: seeded.activityId, after: 0, limit: 20 });
    expect(events.at(-1)).toMatchObject({ type: "ParticipantAccountClaimIssued" });
    expect(JSON.stringify(events)).not.toContain(issued.token);
  });

  it("creates one local account, links it, and redacts replay credentials", async () => {
    const seeded = await seedRegistration();
    const issued = await issueClaim(seeded.activityId, seeded.registrationId);
    const username = `claim-user-${randomUUID().slice(0, 8)}`;
    const consumeCommandId = `consume-${randomUUID()}`;
    const consumed = await consumeParticipantClaim(db, deps(), {
      commandId: consumeCommandId,
      token: issued.token,
      username,
      password: "claim-password-123",
    });

    expect(consumed.replayed).toBe(false);
    expect(consumed.body.actor.actorId).toMatch(/^participant:/);
    expect(Object.hasOwn(consumed.body.actor, "authContext")).toBe(false);
    expect(consumed.body.sessionToken).toEqual(expect.any(String));
    await expect(getLocalAccount(db, username)).resolves.toMatchObject({ username });
    await expect(getParticipantIdentityLinkByLegacy(db, seeded.legacyParticipantId)).resolves.toMatchObject({
      actorId: consumed.body.actor.actorId,
      claimId: expect.any(String),
    });

    const replayCommandId = `replay-${randomUUID()}`;
    const replay = await consumeParticipantClaim(db, deps(), {
      commandId: replayCommandId,
      token: issued.token,
      username,
      password: "claim-password-123",
    }).catch((error: unknown) => error);
    expect(replay).toMatchObject({ code: "INVALID_PARTICIPANT_CLAIM" });

    const acceptedCommand = await db.selectFrom("command_receipt")
      .select(["command_id", "result"])
      .where("command_id", "=", consumeCommandId)
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(acceptedCommand.result)).not.toContain(consumed.body.sessionToken ?? "");
    const audit = await db.selectFrom("audit_entry")
      .select("detail")
      .where("command_id", "=", consumeCommandId)
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(audit.detail)).not.toContain(issued.token);
    const events = await readEventsSince(db, { activityId: seeded.activityId, after: 0, limit: 20 });
    expect(JSON.stringify(events)).not.toContain(issued.token);
    expect(JSON.stringify(events)).not.toContain(consumed.body.sessionToken ?? "");
  });

  it("replays the same consume command without creating another account", async () => {
    const seeded = await seedRegistration();
    const issued = await issueClaim(seeded.activityId, seeded.registrationId);
    const commandId = `consume-replay-${randomUUID()}`;
    const input = {
      commandId,
      token: issued.token,
      username: `replay-user-${randomUUID().slice(0, 8)}`,
      password: "claim-password-123",
    };
    const first = await consumeParticipantClaim(db, deps(), input);
    const replay = await consumeParticipantClaim(db, deps(), input);
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.body.sessionToken).toBeNull();
    expect(Object.hasOwn(replay.body.actor, "authContext")).toBe(false);
    expect(await db.selectFrom("participant_identity_link")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("legacy_participant_id", "=", seeded.legacyParticipantId)
      .executeTakeFirstOrThrow()).toMatchObject({ count: "1" });
    expect(await db.selectFrom("audit_entry").select(({ fn }) => fn.countAll<number>().as("count"))
      .where("command_id", "=", commandId).executeTakeFirstOrThrow()).toMatchObject({ count: "1" });
  });

  it("allows an authenticated participant session but rejects credential injection", async () => {
    const seeded = await seedRegistration();
    const issued = await issueClaim(seeded.activityId, seeded.registrationId);
    const participant: ActorContext = {
      actorId: `participant:${randomUUID()}`,
      actorType: "user",
      roles: ["participant"],
      permissions: [],
    };
    const consumed = await consumeParticipantClaim(db, deps(participant), {
      commandId: `consume-session-${randomUUID()}`,
      token: issued.token,
    });
    expect(consumed.body.actor.actorId).toBe(participant.actorId);
    expect(consumed.body.sessionToken).toBeUndefined();

    const second = await seedRegistration();
    const secondClaim = await issueClaim(second.activityId, second.registrationId);
    await expect(consumeParticipantClaim(db, deps({ ...participant, actorId: `participant:${randomUUID()}` }), {
      commandId: `consume-session-credentials-${randomUUID()}`,
      token: secondClaim.token,
      username: "should-not-be-used",
      password: "claim-password-123",
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const claim = await getParticipantClaimByDigestForUpdate(db, stableHash(secondClaim.token));
    expect(claim?.consumedAt).toBeNull();

    const staffClaim = await seedRegistration();
    const staffIssued = await issueClaim(staffClaim.activityId, staffClaim.registrationId);
    await expect(consumeParticipantClaim(db, deps(staff), {
      commandId: `consume-staff-session-${randomUUID()}`,
      token: staffIssued.token,
    })).rejects.toMatchObject({ code: "INVALID_PARTICIPANT_CLAIM" });
    await expect(getParticipantClaimByDigestForUpdate(db, stableHash(staffIssued.token)))
      .resolves.toMatchObject({ consumedAt: null });
  });

  it("keeps the claim unconsumed on username conflict", async () => {
    const seeded = await seedRegistration();
    const issued = await issueClaim(seeded.activityId, seeded.registrationId);
    const username = `taken-${randomUUID().slice(0, 8)}`;
    await insertLocalAccount(db, {
      username,
      passwordDigest: hashPassword("existing-password-123"),
      actor: {
        actorId: `participant:${randomUUID()}`,
        actorType: "user",
        roles: ["participant"],
        permissions: [],
      },
      active: true,
    });

    await expect(consumeParticipantClaim(db, deps(), {
      commandId: `consume-conflict-${randomUUID()}`,
      token: issued.token,
      username,
      password: "claim-password-123",
    })).rejects.toMatchObject({ code: "USERNAME_TAKEN" });
    await expect(getParticipantClaimByDigestForUpdate(db, stableHash(issued.token)))
      .resolves.toMatchObject({ consumedAt: null, consumedByActorId: null });
  });

  it("returns one generic error for invalid, expired, or inconsistent claims", async () => {
    const missing = consumeParticipantClaim(db, deps(), {
      commandId: `consume-missing-${randomUUID()}`,
      token: `AF1.CLAIM.missing.${randomUUID()}`,
      username: `missing-${randomUUID().slice(0, 8)}`,
      password: "claim-password-123",
    });
    await expect(missing).rejects.toMatchObject({ code: "INVALID_PARTICIPANT_CLAIM" });

    const expiredSeed = await seedRegistration();
    const expired = await issueClaim(expiredSeed.activityId, expiredSeed.registrationId);
    await db.updateTable("participant_claim")
      .set({ expires_at: "2026-10-31T23:59:59.000Z" })
      .where("token_digest", "=", stableHash(expired.token))
      .execute();
    await expect(consumeParticipantClaim(db, deps(), {
      commandId: `consume-expired-${randomUUID()}`,
      token: expired.token,
      username: `expired-${randomUUID().slice(0, 8)}`,
      password: "claim-password-123",
    })).rejects.toMatchObject({ code: "INVALID_PARTICIPANT_CLAIM" });

    const malformed = await seedRegistration();
    const wrongActivity = await seedRegistration();
    const malformedToken = `AF1.CLAIM.malformed.${randomUUID()}`;
    await insertParticipantClaim(db, {
      id: `claim-${randomUUID()}`,
      activityId: wrongActivity.activityId,
      registrationId: malformed.registrationId,
      legacyParticipantId: malformed.legacyParticipantId,
      tokenDigest: stableHash(malformedToken),
      expiresAt: "2026-11-02T00:00:00.000Z",
      consumedAt: null,
      consumedByActorId: null,
      issuedBy: staff.actorId,
    });
    await expect(consumeParticipantClaim(db, deps(), {
      commandId: `consume-malformed-${randomUUID()}`,
      token: malformedToken,
      username: `malformed-${randomUUID().slice(0, 8)}`,
      password: "claim-password-123",
    })).rejects.toMatchObject({ code: "INVALID_PARTICIPANT_CLAIM" });
  });

  it("rejects non-legacy issuance and an actor already linked elsewhere", async () => {
    const nonLegacy = await seedRegistration("participant:already-local");
    await expect(issueParticipantClaim(db, deps(staff), {
      commandId: `issue-nonlegacy-${randomUUID()}`,
      activityId: nonLegacy.activityId,
      registrationId: nonLegacy.registrationId,
    })).rejects.toMatchObject({ code: "INVALID_PARTICIPANT_CLAIM" });

    const first = await seedRegistration();
    const second = await seedRegistration();
    const firstClaim = await issueClaim(first.activityId, first.registrationId);
    const secondClaim = await issueClaim(second.activityId, second.registrationId);
    const actor: ActorContext = {
      actorId: `participant:${randomUUID()}`,
      actorType: "user",
      roles: ["participant"],
      permissions: [],
    };
    await consumeParticipantClaim(db, deps(actor), {
      commandId: `consume-first-link-${randomUUID()}`,
      token: firstClaim.token,
    });
    await expect(consumeParticipantClaim(db, deps(actor), {
      commandId: `consume-second-link-${randomUUID()}`,
      token: secondClaim.token,
    })).rejects.toMatchObject({ code: "INVALID_PARTICIPANT_CLAIM" });
  });

  it("allows only one of two concurrent consumers to establish the link", async () => {
    const seeded = await seedRegistration();
    const issued = await issueClaim(seeded.activityId, seeded.registrationId);
    const results = await Promise.allSettled([
      consumeParticipantClaim(db, deps(), {
        commandId: `consume-concurrent-a-${randomUUID()}`,
        token: issued.token,
        username: `concurrent-a-${randomUUID().slice(0, 8)}`,
        password: "claim-password-123",
      }),
      consumeParticipantClaim(db, deps(), {
        commandId: `consume-concurrent-b-${randomUUID()}`,
        token: issued.token,
        username: `concurrent-b-${randomUUID().slice(0, 8)}`,
        password: "claim-password-123",
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const link = await getParticipantIdentityLinkByLegacy(db, seeded.legacyParticipantId);
    expect(link).not.toBeNull();
    await expect(getParticipantIdentityLinkByActor(db, link?.actorId ?? "")).resolves.not.toBeNull();
  });

  it("serializes concurrent claims for the same legacy identity", async () => {
    const seeded = await seedRegistration();
    const first = await issueClaim(seeded.activityId, seeded.registrationId);
    const second = await issueClaim(seeded.activityId, seeded.registrationId);
    const results = await Promise.allSettled([
      consumeParticipantClaim(db, deps(), {
        commandId: `consume-same-legacy-a-${randomUUID()}`,
        token: first.token,
        username: `same-legacy-a-${randomUUID().slice(0, 8)}`,
        password: "claim-password-123",
      }),
      consumeParticipantClaim(db, deps(), {
        commandId: `consume-same-legacy-b-${randomUUID()}`,
        token: second.token,
        username: `same-legacy-b-${randomUUID().slice(0, 8)}`,
        password: "claim-password-123",
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await db.selectFrom("participant_identity_link")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("legacy_participant_id", "=", seeded.legacyParticipantId)
      .executeTakeFirstOrThrow()).toMatchObject({ count: "1" });
  });

  it("revokes an older unconsumed claim when staff issues a replacement", async () => {
    const seeded = await seedRegistration();
    const first = await issueClaim(seeded.activityId, seeded.registrationId);
    const second = await issueClaim(seeded.activityId, seeded.registrationId);

    await expect(consumeParticipantClaim(db, deps(), {
      commandId: `consume-revoked-${randomUUID()}`,
      token: first.token,
      username: `revoked-${randomUUID().slice(0, 8)}`,
      password: "claim-password-123",
    })).rejects.toMatchObject({ code: "INVALID_PARTICIPANT_CLAIM" });

    await expect(consumeParticipantClaim(db, deps(), {
      commandId: `consume-replacement-${randomUUID()}`,
      token: second.token,
      username: `replacement-${randomUUID().slice(0, 8)}`,
      password: "claim-password-123",
    })).resolves.toMatchObject({ replayed: false });
  });

  it("reissues after an old claim has an inconsistent activity binding", async () => {
    const seeded = await seedRegistration();
    const alternateActivityId = `act-claim-alternate-${randomUUID()}`;
    await db.insertInto("activity").values({
      id: alternateActivityId,
      public_code: `CLAIM-${randomUUID().slice(0, 8)}`,
      title: "Participant claim alternate activity",
      status: "active",
      revision: 1,
      enabled_capabilities: JSON.stringify(["registration"]),
      active_definition_version: 1,
    }).execute();
    const staleToken = `AF1.CLAIM.stale-${randomUUID()}`;
    await insertParticipantClaim(db, {
      id: `claim-stale-binding-${randomUUID()}`,
      activityId: alternateActivityId,
      registrationId: seeded.registrationId,
      legacyParticipantId: seeded.legacyParticipantId,
      tokenDigest: stableHash(staleToken),
      expiresAt: "2026-11-10T00:00:00.000Z",
      consumedAt: null,
      consumedByActorId: null,
      issuedBy: staff.actorId,
    });

    const issued = await issueClaim(seeded.activityId, seeded.registrationId);
    expect(issued.token).toMatch(/^AF1\.CLAIM\./);
    await expect(getParticipantClaimByDigestForUpdate(db, stableHash(staleToken)))
      .resolves.toMatchObject({ revokedAt: expect.any(String) });
  });

  it("keeps reissue and consume on one activity-registration-claim lock order", async () => {
    const seeded = await seedRegistration();
    const first = await issueClaim(seeded.activityId, seeded.registrationId);
    const blocker = await openTestClient();
    const pending: Promise<unknown>[] = [];
    try {
      await blocker.query("begin");
      await blocker.query(
        `select id from "activity" where id = $1 for update`,
        [seeded.activityId],
      );

      const issuePromise = issueParticipantClaim(db, deps(staff), {
        commandId: `issue-lock-order-${randomUUID()}`,
        activityId: seeded.activityId,
        registrationId: seeded.registrationId,
      });
      pending.push(issuePromise);
      await waitForBlockedActivityLocks(1);

      const consumePromise = consumeParticipantClaim(db, deps(), {
        commandId: `consume-lock-order-${randomUUID()}`,
        token: first.token,
        username: `lock-order-${randomUUID().slice(0, 8)}`,
        password: "claim-password-123",
      });
      pending.push(consumePromise);
      await waitForBlockedActivityLocks(2);

      await blocker.query("rollback");
      const results = await Promise.allSettled([issuePromise, consumePromise]);

      expect(results[0]?.status).toBe("fulfilled");
      expect(results[1]).toMatchObject({
        status: "rejected",
        reason: { code: "INVALID_PARTICIPANT_CLAIM" },
      });
    } finally {
      await blocker.query("rollback").catch(() => undefined);
      await Promise.allSettled(pending);
      await blocker.end();
    }
  });
});
