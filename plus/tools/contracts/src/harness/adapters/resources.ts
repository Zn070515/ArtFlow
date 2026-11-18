import type { ContractDescriptor } from "@artflow-plus/contracts";
import { insertRelease } from "@artflow-plus/db";
import type { Database, StoredResourceBooking } from "@artflow-plus/db";
import {
  compileResourcesDefinition,
  createResourcesDefinition,
  type ActorContext,
} from "@artflow-plus/domain";
import {
  cancelResourceBookingCommand,
  confirmResourceBookingCommand,
  createResourceBooking,
} from "@artflow-plus/runtime";
import type { CommandOutcome } from "@artflow-plus/runtime";
import type { Kysely } from "kysely";

import type { ContractClock } from "../clock.js";
import { commandCounters, type CommandAdapter } from "../command.js";
import type { LifecycleAdapter, LifecycleOutcome, LifecycleState } from "../lifecycle.js";

export interface ResourcesContractAdapter extends LifecycleAdapter {
  readonly descriptor: ContractDescriptor;
  readonly activityId: string;
  readonly staff: ActorContext;
  readonly outsider: ActorContext;
  readonly startCommand: CommandAdapter<StoredResourceBooking>;
  rollbackDeps(): ReturnType<ContractClock["deps"]>;
}

export const RESOURCES_CONTRACT_DESCRIPTOR: ContractDescriptor = {
  id: "resources",
  version: 1,
  kind: "lifecycle",
  provider: "resources.booking.create",
  consumers: ["ops resources card"],
  preconditions: ["activity is active", "resources definition is released"],
  outputs: ["resource booking", "ResourceBooking* events"],
  invariants: [
    "draft bookings may overlap",
    "confirmed bookings for one activity/resource never overlap",
    "cancelled bookings are terminal and require a reason",
  ],
  errors: ["STALE_REVISION", "INVALID_TRANSITION", "RESOURCE_CONFLICT", "BOOKING_CANCELLED"],
  sideEffects: ["command receipt", "audit entry", "outbox event"],
  idempotency: "the same command id and payload replays the stored body",
  concurrency: "activity lock, booking row lock and a per-resource advisory lock",
  recovery: "cancel releases the slot; a new booking can then be confirmed",
};

const staff: ActorContext = {
  actorId: "resources-contract-staff",
  actorType: "user",
  roles: ["staff"],
  permissions: ["resources.manage"],
};

const outsider: ActorContext = {
  actorId: "resources-contract-outsider",
  actorType: "user",
  roles: ["participant"],
  permissions: [],
};

export function createResourcesContractAdapter(
  db: Kysely<Database>,
  clock: ContractClock,
): ResourcesContractAdapter {
  let activityId = "";
  let bookingId: string | undefined;

  const executeLifecycle = async (
    command: string,
    expectedRevision: number,
    commandId = `contract-resources-${command}-${clock.newEventId()}`,
  ): Promise<LifecycleOutcome> => {
    let outcome: CommandOutcome<StoredResourceBooking>;
    if (command === "create") {
      outcome = await createResourceBooking(db, clock.deps(staff), {
        commandId,
        activityId,
        resourceKey: "hall",
        title: "Contract rehearsal",
        startsAt: "2026-12-01T10:00:00.000Z",
        endsAt: "2026-12-01T12:00:00.000Z",
      });
      bookingId = outcome.body.id;
    } else if (command === "confirm") {
      if (bookingId === undefined) throw new Error("create must run before confirm");
      outcome = await confirmResourceBookingCommand(db, clock.deps(staff), {
        commandId,
        activityId,
        bookingId,
        expectedRevision,
      });
    } else if (command === "cancel") {
      if (bookingId === undefined) throw new Error("create must run before cancel");
      outcome = await cancelResourceBookingCommand(db, clock.deps(staff), {
        commandId,
        activityId,
        bookingId,
        expectedRevision,
        reason: "contract cancel",
      });
    } else {
      throw new Error(`Unknown resources lifecycle command: ${command}`);
    }
    return {
      status: outcome.body.status,
      revision: outcome.body.revision,
      replayed: outcome.replayed,
      commandId,
    };
  };

  const startCommand: CommandAdapter<StoredResourceBooking> = {
    name: "resources.booking.create",
    get activityId() {
      return activityId;
    },
    actor: staff,
    commandType: "resources.booking.create",
    capability: "resources",
    async execute({ commandId, actor }) {
      return createResourceBooking(db, clock.deps(actor ?? staff), {
        commandId,
        activityId,
        resourceKey: "hall",
        title: "Contract rehearsal",
        startsAt: "2026-12-01T10:00:00.000Z",
        endsAt: "2026-12-01T12:00:00.000Z",
      });
    },
    ...commandCounters(db, () => activityId),
  };

  return {
    name: "resources",
    provider: RESOURCES_CONTRACT_DESCRIPTOR.provider,
    descriptor: RESOURCES_CONTRACT_DESCRIPTOR,
    revisionMode: "required",
    lifecycle: {
      states: ["draft", "confirmed", "cancelled"],
      initial: "draft",
      terminal: ["cancelled"],
      transitions: [
        { command: "create", from: "none", to: "draft", revisionDelta: 0 },
        { command: "confirm", from: "draft", to: "confirmed", revisionDelta: 1 },
        { command: "cancel", from: "confirmed", to: "cancelled", revisionDelta: 1 },
      ],
    },
    illegal: [
      { command: "confirm", expectedRevision: 99, code: "INVALID_TRANSITION" },
      { command: "cancel", expectedRevision: 99, code: "BOOKING_CANCELLED" },
    ],
    get activityId() {
      return activityId;
    },
    staff,
    outsider,
    startCommand,
    rollbackDeps: () => clock.deps(staff),
    async setup() {
      activityId = `contract-resources-${clock.newEventId()}`;
      bookingId = undefined;
      const artifact = compileResourcesDefinition(createResourcesDefinition([
        { key: "hall", name: "Contract hall", kind: "venue", capacity: 100, notes: "" },
      ]));
      if (!artifact.ok) throw new Error(JSON.stringify(artifact));
      await db.insertInto("activity").values({
        id: activityId,
        title: "Contract resources",
        status: "active",
        revision: 1,
        enabled_capabilities: JSON.stringify(["resources"]),
        active_definition_version: 1,
      }).execute();
      await insertRelease(db, {
        activityId,
        version: 1,
        contentHash: "contract-resources-release",
        capabilities: { resources: artifact },
        executionPolicy: {
          declaredScopes: [],
          conflicts: {},
          runtimeContractVersion: 2,
          commandScopes: {},
        },
        capabilityVersions: { resources: "1.0.0" },
        bindings: [],
        releasedAt: "2026-11-11T12:00:00Z",
        sourceDraftRevision: 1,
      });
    },
    execute: executeLifecycle,
    async read(): Promise<LifecycleState> {
      if (bookingId === undefined) return { status: "none", revision: 0 };
      const row = await db.selectFrom("resource_booking")
        .select(["status", "revision"])
        .where("id", "=", bookingId)
        .executeTakeFirstOrThrow();
      return { status: row.status, revision: row.revision };
    },
  };
}
