import { insertJudgeEntrySeat, insertRelease } from "@artflow-plus/db";
import type { Database, StoredTicket } from "@artflow-plus/db";
import type { ActorContext } from "@artflow-plus/domain";
import {
  authenticateJudgeSession,
  capabilityCredential,
  claimJudgeSeat,
  issueTicket,
  redeemTicketCredential,
  revokeTicket,
  rotateTicketCredential,
} from "@artflow-plus/runtime";
import type {
  ClaimedJudgeSeatResult,
  CommandOutcome,
  IssuedTicketResult,
} from "@artflow-plus/runtime";
import type { Kysely } from "kysely";

import type { ContractClock } from "../clock.js";
import type { CommandAdapter } from "../command.js";
import type {
  LifecycleAdapter,
  LifecycleOutcome,
  LifecycleState,
} from "../lifecycle.js";

const CREDENTIAL_SECRET = "contract-credential-secret";

export interface TicketingContractAdapter extends LifecycleAdapter {
  readonly activityId: string;
  readonly staff: ActorContext;
  readonly judge: ActorContext;
  readonly issueCommand: CommandAdapter<IssuedTicketResult>;
  claim(commandId: string): Promise<CommandOutcome<ClaimedJudgeSeatResult>>;
  authenticate(token: string): Promise<unknown>;
  archive(): Promise<void>;
}

const staff: ActorContext = {
  actorId: "contract-ticket-staff",
  actorType: "user",
  roles: ["staff"],
  permissions: ["ticket.manage", "judge.manage"],
};

const judge: ActorContext = {
  actorId: "contract-judge",
  actorType: "user",
  roles: ["judge"],
  permissions: [],
};

export function createTicketingContractAdapter(
  db: Kysely<Database>,
  clock: ContractClock,
): TicketingContractAdapter {
  let activityId = "";
  let ticketId: string | undefined;
  let credential: string | undefined;

  const deps = (actor: ActorContext) => clock.deps(actor, CREDENTIAL_SECRET);

  const executeLifecycle = async (
    command: string,
    _expectedRevision: number,
    commandId = `contract-ticket-${command}-${clock.newEventId()}`,
  ): Promise<LifecycleOutcome> => {
    if (command === "issue") {
      const outcome = await issueTicket(db, deps(staff), { commandId, activityId });
      ticketId = outcome.body.ticket.id;
      credential = outcome.body.credential;
      return {
        status: outcome.body.ticket.state,
        revision: outcome.body.ticket.credentialVersion - 1,
        replayed: outcome.replayed,
        commandId,
      };
    }
    if (ticketId === undefined) throw new Error("issue must run first");
    if (command === "rotate") {
      const outcome = await rotateTicketCredential(db, deps(staff), {
        commandId,
        activityId,
        ticketId,
      });
      credential = outcome.body.credential;
      return {
        status: outcome.body.ticket.state,
        revision: outcome.body.ticket.credentialVersion - 1,
        replayed: outcome.replayed,
        commandId,
      };
    }
    if (command === "redeem") {
      if (credential === undefined) throw new Error("no credential to redeem");
      const outcome = await redeemTicketCredential(db, deps(judge), { commandId, credential });
      const state = await read();
      return {
        status: state.status,
        revision: state.revision,
        replayed: outcome.replayed,
        commandId,
      };
    }
    if (command === "revoke") {
      const outcome = await revokeTicket(db, deps(staff), {
        commandId,
        activityId,
        ticketId,
        reason: "contract revoke",
      });
      return {
        status: outcome.body.state,
        revision: outcome.body.credentialVersion - 1,
        replayed: outcome.replayed,
        commandId,
      };
    }
    throw new Error(`Unknown ticketing lifecycle command: ${command}`);
  };

  const read = async (): Promise<LifecycleState> => {
    if (ticketId === undefined) return { status: "none", revision: 0 };
    const row = await db.selectFrom("ticket")
      .select(["state", "credential_version"])
      .where("id", "=", ticketId)
      .executeTakeFirstOrThrow();
    return { status: row.state, revision: row.credential_version - 1 };
  };

  const issueCommand: CommandAdapter<IssuedTicketResult> = {
    name: "ticketing.ticket.issue",
    get activityId() {
      return activityId;
    },
    actor: staff,
    commandType: "ticketing.ticket.issue",
    capability: "ticketing",
    async execute({ commandId, actor }) {
      return issueTicket(db, deps(actor ?? staff), { commandId, activityId });
    },
    async countReceipts(commandId) {
      const row = await db.selectFrom("command_receipt")
        .select((expression) => expression.fn.countAll<number>().as("count"))
        .where("command_id", "=", commandId)
        .executeTakeFirstOrThrow();
      return Number(row.count);
    },
    async countAudits(commandId) {
      const row = await db.selectFrom("audit_entry")
        .select((expression) => expression.fn.countAll<number>().as("count"))
        .where("command_id", "=", commandId)
        .executeTakeFirstOrThrow();
      return Number(row.count);
    },
    async eventCount() {
      const row = await db.selectFrom("outbox")
        .select((expression) => expression.fn.countAll<number>().as("count"))
        .where("activity_id", "=", activityId)
        .executeTakeFirstOrThrow();
      return Number(row.count);
    },
  };

  return {
    name: "ticketing",
    provider: "ticketing.ticket.issue",
    revisionMode: "none",
    lifecycle: {
      states: ["issued", "redeemed"],
      initial: "issued",
      terminal: ["redeemed"],
      transitions: [
        { command: "issue", from: "none", to: "issued", revisionDelta: 0 },
        { command: "rotate", from: "issued", to: "issued", revisionDelta: 1 },
        { command: "redeem", from: "issued", to: "redeemed", revisionDelta: 0 },
      ],
    },
    variants: [
      {
        name: "revoke",
        transitions: [
          { command: "issue", from: "none", to: "issued", revisionDelta: 0 },
          { command: "rotate", from: "issued", to: "issued", revisionDelta: 1 },
          { command: "revoke", from: "issued", to: "revoked", revisionDelta: 0 },
        ],
        terminal: ["revoked"],
      },
    ],
    illegal: [
      { command: "rotate", expectedRevision: 0, code: "INVALID_TRANSITION" },
      { command: "redeem", expectedRevision: 0, code: "TICKET_REPLAYED" },
    ],
    get activityId() {
      return activityId;
    },
    staff,
    judge,
    issueCommand,
    async setup() {
      activityId = `contract-ticketing-${clock.newEventId()}`;
      ticketId = undefined;
      credential = undefined;
      await db.insertInto("activity").values({
        id: activityId,
        public_code: activityId,
        title: "Contract ticketing",
        status: "active",
        revision: 1,
        enabled_capabilities: JSON.stringify(["ticketing"]),
        active_definition_version: 1,
      }).execute();
      await insertRelease(db, {
        activityId,
        version: 1,
        contentHash: "contract-ticketing-release",
        capabilities: {
          ticketing: {
            ok: true,
            capabilityKey: "ticketing",
            contentHash: "contract-ticketing",
            artifact: { schemaVersion: 1 },
          },
        },
        executionPolicy: {
          declaredScopes: ["judging"],
          conflicts: {},
          runtimeContractVersion: 2,
          commandScopes: {},
        },
        capabilityVersions: { ticketing: "1" },
        bindings: [],
        releasedAt: "2026-11-11T12:00:00Z",
        sourceDraftRevision: 1,
      });
      await insertJudgeEntrySeat(db, {
        id: `contract-seat-${clock.newEventId()}`,
        activityId,
        seatKey: "seat-1",
        state: "available",
        revision: 0,
      });
    },
    execute: executeLifecycle,
    read,
    async claim(commandId: string) {
      return claimJudgeSeat(db, deps(judge), {
        commandId,
        publicCode: activityId,
        capability: capabilityCredential("J", activityId, 1, CREDENTIAL_SECRET),
      });
    },
    async authenticate(token: string) {
      // Validate against the same contract clock that minted the session, not
      // wall time: the fixed 2026-11-11 start would otherwise expire the
      // eight-hour judge session as soon as the real date moved on.
      return authenticateJudgeSession(db, token, new Date(clock.now()));
    },
    async archive() {
      await db.updateTable("activity").set({ status: "archived" })
        .where("id", "=", activityId)
        .execute();
    },
  };
}
