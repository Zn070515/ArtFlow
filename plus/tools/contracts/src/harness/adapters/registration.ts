import { insertRelease } from "@artflow-plus/db";
import type { Database, StoredRegistration } from "@artflow-plus/db";
import type { ActorContext } from "@artflow-plus/domain";
import {
  reviewRegistration,
  saveRegistrationAnswer,
  startRegistration,
  submitRegistration,
} from "@artflow-plus/runtime";
import type { CommandOutcome } from "@artflow-plus/runtime";
import type { Kysely } from "kysely";

import type { ContractClock } from "../clock.js";
import type { CommandAdapter } from "../command.js";
import type {
  LifecycleAdapter,
  LifecycleOutcome,
  LifecycleState,
} from "../lifecycle.js";

export interface RegistrationContractAdapter extends LifecycleAdapter {
  readonly activityId: string;
  readonly participant: ActorContext;
  readonly staff: ActorContext;
  readonly outsider: ActorContext;
  readonly startCommand: CommandAdapter<StoredRegistration>;
  rollbackDeps(): ReturnType<ContractClock["deps"]>;
}

const participant: ActorContext = {
  actorId: "contract-participant",
  actorType: "user",
  roles: ["participant"],
  permissions: [],
};

const staff: ActorContext = {
  actorId: "contract-staff",
  actorType: "user",
  roles: ["staff"],
  permissions: ["registration.manage", "registration.review", "registration.roster.finalize"],
};

const outsider: ActorContext = {
  actorId: "contract-outsider",
  actorType: "user",
  roles: ["participant"],
  permissions: [],
};

const questionnaireArtifact = {
  schemaVersion: 1,
  version: "v1",
  schemaHash: "contract-questionnaire",
  questions: [{ key: "name", label: "Name", type: "text", required: true }],
  fileSlots: [],
};

export function createRegistrationContractAdapter(
  db: Kysely<Database>,
  clock: ContractClock,
): RegistrationContractAdapter {
  let activityId = "";
  let registrationId: string | undefined;

  const executeLifecycle = async (
    command: string,
    expectedRevision: number,
    commandId = `contract-registration-${command}-${clock.newEventId()}`,
  ): Promise<LifecycleOutcome> => {
    const deps = clock.deps(participant);
    let outcome: CommandOutcome<StoredRegistration>;
    if (command === "start") {
      outcome = await startRegistration(db, deps, {
        commandId,
        activityId,
        participantId: participant.actorId,
      });
      registrationId = outcome.body.id;
    } else if (command === "answer") {
      if (registrationId === undefined) throw new Error("start must run before answer");
      outcome = await saveRegistrationAnswer(db, deps, {
        commandId,
        activityId,
        registrationId,
        expectedRevision,
        questionKey: "name",
        value: "Alice",
      });
    } else if (command === "submit") {
      if (registrationId === undefined) throw new Error("start must run before submit");
      outcome = await submitRegistration(db, deps, {
        commandId,
        activityId,
        registrationId,
        expectedRevision,
      });
    } else if (command === "review") {
      if (registrationId === undefined) throw new Error("start must run before review");
      outcome = await reviewRegistration(db, clock.deps(staff), {
        commandId,
        activityId,
        registrationId,
        expectedRevision,
        status: "approved",
        note: "contract review",
      });
    } else {
      throw new Error(`Unknown registration lifecycle command: ${command}`);
    }
    return {
      status: outcome.body.status,
      revision: outcome.body.revision,
      replayed: outcome.replayed,
      commandId,
    };
  };

  const startCommand: CommandAdapter<StoredRegistration> = {
    name: "registration.start",
    get activityId() {
      return activityId;
    },
    actor: participant,
    commandType: "registration.start",
    capability: "registration",
    async execute({ commandId, actor, payload }) {
      return startRegistration(db, clock.deps(actor ?? participant), {
        commandId,
        activityId,
        participantId: typeof payload === "string" ? payload : participant.actorId,
      });
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
    name: "registration",
    provider: "registration.start",
    revisionMode: "required",
    lifecycle: {
      states: ["draft", "submitted", "approved"],
      initial: "draft",
      terminal: ["approved"],
      transitions: [
        { command: "start", from: "none", to: "draft", revisionDelta: 0 },
        { command: "answer", from: "draft", to: "draft", revisionDelta: 1 },
        { command: "submit", from: "draft", to: "submitted", revisionDelta: 1 },
        { command: "review", from: "submitted", to: "approved", revisionDelta: 1 },
      ],
    },
    illegal: [
      { command: "answer", expectedRevision: 99, code: "STALE_REVISION" },
      { command: "review", expectedRevision: 3, code: "INVALID_TRANSITION" },
      { command: "submit", expectedRevision: 3, code: "INVALID_TRANSITION" },
      { command: "start", expectedRevision: 0, code: "INVALID_TRANSITION" },
    ],
    get activityId() {
      return activityId;
    },
    participant,
    staff,
    outsider,
    startCommand,
    rollbackDeps: () => clock.deps(participant),
    async setup() {
      activityId = `contract-registration-${clock.newEventId()}`;
      registrationId = undefined;
      await db.insertInto("activity").values({
        id: activityId,
        title: "Contract registration",
        status: "active",
        revision: 1,
        enabled_capabilities: JSON.stringify(["registration", "questionnaire", "materials"]),
        active_definition_version: 1,
      }).execute();
      await insertRelease(db, {
        activityId,
        version: 1,
        contentHash: "contract-registration-release",
        capabilities: {
          registration: {
            ok: true,
            capabilityKey: "registration",
            contentHash: "contract-registration",
            artifact: { schemaVersion: 1, lifecycleVersion: 1, rosterStatus: "unknown" },
          },
          questionnaire: {
            ok: true,
            capabilityKey: "questionnaire",
            contentHash: "contract-questionnaire",
            artifact: questionnaireArtifact,
          },
          materials: {
            ok: true,
            capabilityKey: "materials",
            contentHash: "contract-materials",
            artifact: { schemaVersion: 1, maxBytes: 25_000_000, allowedPurposes: [] },
          },
        },
        executionPolicy: {
          declaredScopes: [],
          conflicts: {},
          runtimeContractVersion: 2,
          commandScopes: {},
        },
        capabilityVersions: { registration: "1", questionnaire: "1", materials: "1" },
        bindings: [],
        releasedAt: "2026-11-11T12:00:00Z",
        sourceDraftRevision: 1,
      });
    },
    execute: executeLifecycle,
    async read(): Promise<LifecycleState> {
      if (registrationId === undefined) return { status: "none", revision: 0 };
      const row = await db.selectFrom("registration")
        .select(["status", "revision"])
        .where("id", "=", registrationId)
        .executeTakeFirstOrThrow();
      return { status: row.status, revision: row.revision };
    },
  };
}
