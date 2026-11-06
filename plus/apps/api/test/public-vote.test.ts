import { VOTING_COMMAND_SCOPES } from "@artflow-plus/domain";
import { randomUUID } from "node:crypto";

import {
  closeDb,
  createDb,
  insertRelease,
  insertSession,
  migrate,
} from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import { stableHash } from "@artflow-plus/runtime";
import type { RuntimeDeps } from "@artflow-plus/runtime";
import type { FastifyInstance } from "fastify";
import { Client } from "pg";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_api_public_vote_${Date.now()}_${process.pid}`;

let app: FastifyInstance;
let db: Kysely<Database>;
let admin: Client;

const deps: RuntimeDeps = {
  now: () => new Date().toISOString(),
  newEventId: () => randomUUID(),
};

async function seed(options: {
  readonly mode?: "formal" | "rehearsal";
  readonly status?: "draft" | "open" | "closed";
  readonly identityPolicy?: "browser" | "ticket" | "anonymous";
} = {}): Promise<{ activityId: string; sessionId: string }> {
  const activityId = `act-${randomUUID()}`;
  const sessionId = `vote-${randomUUID()}`;
  const mode = options.mode ?? "formal";
  const identityPolicy = options.identityPolicy ?? "browser";
  await db.insertInto("activity").values({
    id: activityId,
    public_code: activityId,
    title: "人气投票",
    status: "active",
    revision: 1,
    enabled_capabilities: JSON.stringify(identityPolicy === "ticket" ? ["voting", "ticketing"] : ["voting"]),
    active_definition_version: 1,
  }).execute();
  await insertRelease(db, {
    activityId,
    version: 1,
    contentHash: "public-vote-release",
    capabilities: {
      voting: {
        ok: true,
        capabilityKey: "voting",
        contentHash: "public-vote",
        artifact: {
          version: 2,
          schemaVersion: 2,
          purpose: "popularity",
          selectionType: "single",
          maxSelections: 1,
          identityPolicy,
          scoringRule: { kind: "ballot_share_percent", scale: 100, decimals: 2 },
        },
      },
    },
    executionPolicy: { declaredScopes: ["voting"], conflicts: {}, runtimeContractVersion: 2, commandScopes: VOTING_COMMAND_SCOPES },
    capabilityVersions: { voting: "1" },
    bindings: [],
    releasedAt: "2026-10-27T09:00:00Z",
    sourceDraftRevision: 1,
  });
  if (mode === "formal") {
    await insertSession(db, {
      id: `voting-${activityId}`,
      activityId,
      definitionVersion: 1,
      contentHash: "public-vote-release",
      scope: "voting",
      mode: "formal",
      status: "running",
      revision: 0,
    }, "2026-10-27T09:00:00Z");
  }
  await db.insertInto("vote_session").values({
    id: sessionId,
    activity_id: activityId,
    definition_version: 1,
    mode,
    purpose: "popularity",
    selection_type: "single",
    max_selections: 1,
    identity_policy: identityPolicy,
    scoring_rule: JSON.stringify({ kind: "ballot_share_percent", scale: 100, decimals: 2 }),
    status: options.status ?? "open",
    revision: 0,
    opened_at: "2026-10-27T09:00:00Z",
    closed_at: options.status === "closed" ? "2026-10-27T09:30:00Z" : null,
  }).execute();
  for (const [index, candidateId] of ["alice", "bob"].entries()) {
    await db.insertInto("vote_option").values({
      id: `${sessionId}-option-${index}`,
      activity_id: activityId,
      session_id: sessionId,
      candidate_id: candidateId,
      ordinal: index,
    }).execute();
  }
  return { activityId, sessionId };
}

async function insertBrowserBallot(sessionId: string, fingerprint: string): Promise<void> {
  const session = await db.selectFrom("vote_session").select("activity_id")
    .where("id", "=", sessionId).executeTakeFirstOrThrow();
  await db.insertInto("ballot").values({
    id: `ballot-${randomUUID()}`,
    activity_id: session.activity_id,
    session_id: sessionId,
    identity_type: "browser",
    identity_digest: stableHash(fingerprint),
    ticket_id: null,
    submitted_at: "2026-10-27T09:10:00Z",
  }).execute();
}

describe.skipIf(!connectionString)("public vote session", () => {
  beforeAll(async () => {
    if (!connectionString) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    await migrate(db);
    app = await buildApp({ db, deps, enableRuntimeFacts: true });
    await app.ready();
  });

  afterAll(async () => {
    if (!connectionString) return;
    await app.close();
    await closeDb(db);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("returns activity, candidates, rules, and no counts", async () => {
    const { activityId, sessionId } = await seed();
    const response = await app.inject({
      method: "GET",
      url: `/api/public/vote/${sessionId}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      activityId,
      activityTitle: "人气投票",
      sessionId,
      status: "open",
      selectionType: "single",
      maxSelections: 1,
      identityPolicy: "browser",
      candidates: [
        { candidateId: "alice" },
        { candidateId: "bob" },
      ],
      voted: false,
    });
    expect(JSON.stringify(response.json())).not.toContain("counts");
  });

  it("reports voted for the same browser identity only", async () => {
    const { sessionId } = await seed();
    const fingerprint = "a".repeat(43);
    await insertBrowserBallot(sessionId, fingerprint);

    const voted = await app.inject({
      method: "GET",
      url: `/api/public/vote/${sessionId}`,
      headers: { cookie: `artflow_browser_id=${fingerprint}` },
    });
    expect(voted.json()).toMatchObject({ voted: true });

    const other = "b".repeat(43);
    const stranger = await app.inject({
      method: "GET",
      url: `/api/public/vote/${sessionId}`,
      headers: { cookie: `artflow_browser_id=${other}` },
    });
    expect(stranger.json()).toMatchObject({ voted: false });
  });

  it("returns closed and ticket sessions without hiding the reason", async () => {
    const closed = await seed({ status: "closed" });
    const closedRead = await app.inject({
      method: "GET",
      url: `/api/public/vote/${closed.sessionId}`,
    });
    expect(closedRead.json()).toMatchObject({ status: "closed" });

    const ticket = await seed({ identityPolicy: "ticket" });
    const ticketRead = await app.inject({
      method: "GET",
      url: `/api/public/vote/${ticket.sessionId}`,
    });
    expect(ticketRead.json()).toMatchObject({ identityPolicy: "ticket" });
  });

  it("recognizes a valid ticket access session without exposing credential data", async () => {
    const { activityId, sessionId } = await seed({ identityPolicy: "ticket" });
    const ticketId = "ticket-" + randomUUID();
    const accessToken = "AF1.S." + randomUUID();
    await db.insertInto("ticket").values({
      id: ticketId,
      activity_id: activityId,
      public_code: "T-" + ticketId.slice(-8),
      credential_digest: stableHash("credential-" + ticketId),
      credential_version: 1,
      state: "redeemed",
      issued_at: "2026-10-27T09:00:00Z",
      redeemed_at: "2026-10-27T09:05:00Z",
      revoked_at: null,
    }).execute();
    await db.insertInto("ticket_access_session").values({
      id: "ticket-session-" + ticketId,
      activity_id: activityId,
      ticket_id: ticketId,
      token_digest: stableHash(accessToken),
      expires_at: "2026-10-29T09:00:00Z",
      last_seen_at: null,
      revoked_at: null,
    }).execute();

    const ready = await app.inject({
      method: "GET",
      url: "/api/public/vote/" + sessionId,
      headers: { cookie: "artflow_ticket_session=" + accessToken },
    });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({
      identityPolicy: "ticket",
      ticketReady: true,
      voted: false,
    });
    expect(JSON.stringify(ready.json())).not.toMatch(/ticketId|credential|accessToken|counts/);

    await db.insertInto("ballot").values({
      id: "ballot-" + ticketId,
      activity_id: activityId,
      session_id: sessionId,
      identity_type: "ticket",
      identity_digest: null,
      ticket_id: ticketId,
      submitted_at: "2026-10-27T09:10:00Z",
    }).execute();
    const voted = await app.inject({
      method: "GET",
      url: "/api/public/vote/" + sessionId,
      headers: { cookie: "artflow_ticket_session=" + accessToken },
    });
    expect(voted.json()).toMatchObject({ ticketReady: true, voted: true });

    const invalid = await app.inject({
      method: "GET",
      url: "/api/public/vote/" + sessionId,
      headers: { cookie: "artflow_ticket_session=not-a-session" },
    });
    expect(invalid.json()).toMatchObject({ ticketReady: false, voted: false });
  });

  it("hides rehearsal and draft sessions, and unknown ids", async () => {
    const rehearsal = await seed({ mode: "rehearsal" });
    const hidden = await app.inject({
      method: "GET",
      url: `/api/public/vote/${rehearsal.sessionId}`,
    });
    expect(hidden.statusCode).toBe(404);

    const draft = await seed({ status: "draft" });
    const draftRead = await app.inject({
      method: "GET",
      url: `/api/public/vote/${draft.sessionId}`,
    });
    expect(draftRead.statusCode).toBe(404);

    const unknown = await app.inject({ method: "GET", url: "/api/public/vote/nope" });
    expect(unknown.statusCode).toBe(404);
  });

  it("does not rate-limit ordinary reads", async () => {
    const { sessionId } = await seed();
    for (let index = 0; index < 5; index += 1) {
      const response = await app.inject({
        method: "GET",
        url: `/api/public/vote/${sessionId}`,
      });
      expect(response.statusCode).toBe(200);
    }
  });
});
