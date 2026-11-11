import { describe, expect, it } from "vitest";

import { buildGraphFromSources } from "../src/graph/build.js";
import type { ConsumerGraph, SourceFile } from "../src/graph/schema.js";

const sources: SourceFile[] = [
  {
    path: "packages/runtime/src/command.ts",
    text: `
export async function executeCommand<T>(db: unknown, meta: unknown, handler: () => Promise<T>): Promise<T> {
  return handler();
}
`,
  },
  {
    path: "packages/runtime/src/voting-ticket-service.ts",
    text: `
import { executeCommand } from "./command.js";
import { appendEngineEvent } from "./events.js";

export async function claimJudgeSeat(db: unknown, deps: unknown, input: { activityId: string; commandId: string }) {
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "ticketing",
    commandType: "ticketing.judge_seat.claim",
    payload: {},
  }, async (trx: unknown) => {
    await appendEngineEvent(trx, deps, {
      type: "JudgeSeatClaimed",
      activityId: input.activityId,
      aggregateType: "judge_entry",
      aggregateId: input.activityId,
      capability: "ticketing",
      payload: {},
    });
    return { body: { ok: true } };
  });
}
`,
  },
  {
    path: "packages/runtime/src/events.ts",
    text: `export async function appendEngineEvent(trx: unknown, deps: unknown, event: unknown): Promise<void> {}`,
  },
  {
    path: "packages/domain/src/capabilities/ticketing.ts",
    text: `
export const ticketingCapability = deepFreeze({
  manifest: {
    identity: "ticketing",
    version: "1",
    dependencies: [],
    conflicts: [],
    definitionSchemaVersion: 1,
    commands: ["ticketing.judge_seat.claim"],
    queries: ["ticketing.ticket.read"],
    events: ["JudgeSeatClaimed"],
    permissions: ["ticket.manage"],
    surfaces: ["live"],
    scopes: ["judging"],
  },
  compiler: {},
  emptyDefinition: () => ({}),
});
`,
  },
  {
    path: "apps/api/src/routes/public.ts",
    text: `
import { claimJudgeSeat } from "../../../../packages/runtime/src/voting-ticket-service.js";

app.post("/api/judge-entry/claim", async (request) => {
  const outcome = await claimJudgeSeat(db, publicDeps(), { activityId: "a", commandId: "c" });
  return outcome;
});
`,
  },
  {
    path: "packages/runtime/src/voting-read-service.ts",
    text: `
export async function readVotingSessionsState(db: unknown, activityId: string) {
  return { activityId, sessions: [] };
}
`,
  },
  {
    path: "apps/api/src/realtime-topics.ts",
    text: `
import { readVotingSessionsState } from "../../../packages/runtime/src/voting-read-service.js";

export function createVotingRealtimeTopic(db: unknown) {
  return {
    namespace: "voting",
    async snapshot(target: { activityId: string }) {
      const data = await readVotingSessionsState(db, target.activityId);
      return { seq: 0, data };
    },
  };
}
`,
  },
  {
    path: "apps/worker/src/outbox.ts",
    text: `export async function applyToLiveProjection(trx: unknown, event: unknown): Promise<void> {}`,
  },
];

const dynamic = {
  version: 1 as const,
  eventConsumers: [
    {
      eventType: "JudgeSeatClaimed",
      consumer: "apps/worker/src/outbox.ts#applyToLiveProjection",
      reason: "The worker maintains the derived projection.",
    },
  ],
  commands: [],
  eventProviders: [],
};

function graph(): ConsumerGraph {
  return buildGraphFromSources(sources, dynamic);
}

describe("consumer graph", () => {
  it("links executeCommand metadata to the provider, command, and capability", () => {
    const built = graph();
    const provider = "symbol:packages/runtime/src/voting-ticket-service.ts#claimJudgeSeat";
    const command = "command:ticketing.judge_seat.claim";
    expect(built.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: provider, kind: "symbol" }),
      expect.objectContaining({ id: command, kind: "command" }),
      expect.objectContaining({ id: "capability:ticketing", kind: "capability" }),
    ]));
    expect(built.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: provider, to: command, kind: "invokes-command" }),
      expect.objectContaining({ from: "capability:ticketing", to: command, kind: "declares" }),
    ]));
  });

  it("links appendEngineEvent metadata and declared dynamic consumers", () => {
    const built = graph();
    const provider = "symbol:packages/runtime/src/voting-ticket-service.ts#claimJudgeSeat";
    const event = "event:JudgeSeatClaimed";
    expect(built.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: provider, to: event, kind: "emits" }),
      expect.objectContaining({ from: "capability:ticketing", to: event, kind: "declares" }),
      expect.objectContaining({ from: "symbol:apps/worker/src/outbox.ts#applyToLiveProjection", to: event, kind: "consumes" }),
    ]));
  });

  it("links a route to the runtime symbol it serves", () => {
    const built = graph();
    expect(built.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        from: "route:POST /api/judge-entry/claim",
        to: "symbol:packages/runtime/src/voting-ticket-service.ts#claimJudgeSeat",
        kind: "serves",
      }),
    ]));
  });

  it("links a realtime topic to its snapshot source", () => {
    const built = graph();
    expect(built.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        from: "topic:voting",
        to: "symbol:packages/runtime/src/voting-read-service.ts#readVotingSessionsState",
        kind: "subscribes",
      }),
    ]));
  });

  it("reports no unresolved references for a fully declared fixture", () => {
    expect(graph().unresolved).toEqual([]);
  });

  it("fails when a command provider is not declared by a capability", () => {
    const built = buildGraphFromSources(sources.slice(0, 2), dynamic);
    expect(built.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("ticketing.judge_seat.claim"),
    ]));
  });

  it("accepts declared dynamic command and event seams", () => {
    const dynamicSources: SourceFile[] = [
      {
        path: "packages/runtime/src/command.ts",
        text: `export async function executeCommand<T>(db: unknown, meta: unknown, handler: () => Promise<T>): Promise<T> { return handler(); }`,
      },
      {
        path: "packages/runtime/src/events.ts",
        text: `export async function appendEngineEvent(trx: unknown, deps: unknown, event: unknown): Promise<void> {}`,
      },
      {
        path: "packages/runtime/src/dynamic.ts",
        text: `
import { executeCommand } from "./command.js";
import { appendEngineEvent } from "./events.js";

export async function mutate(db: unknown, deps: unknown, input: { activityId: string; commandId: string; kind: string; type: string }) {
  const commandType = \`probe.\${input.kind}\`;
  return executeCommand(db, {
    commandId: input.commandId,
    activityId: input.activityId,
    capability: "probe",
    commandType,
    payload: {},
  }, async (trx: unknown) => {
    await appendEngineEvent(trx, deps, {
      type: input.type,
      activityId: input.activityId,
      capability: "probe",
      payload: {},
    });
    return { body: {} };
  });
}
`,
      },
      {
        path: "packages/domain/src/capabilities/probe.ts",
        text: `
export const probe = deepFreeze({
  manifest: {
    identity: "probe",
    version: "1",
    dependencies: [],
    conflicts: [],
    definitionSchemaVersion: 1,
    commands: ["probe.one"],
    queries: [],
    events: [],
    permissions: [],
    surfaces: ["ops"],
  },
});
`,
      },
    ];
    const built = buildGraphFromSources(dynamicSources, {
      version: 1,
      eventConsumers: [],
      commands: [
        {
          commandType: "probe.one",
          provider: "packages/runtime/src/dynamic.ts#mutate",
          reason: "The command type is built from a runtime discriminator.",
        },
      ],
      eventProviders: [
        {
          provider: "packages/runtime/src/dynamic.ts#mutate",
          reason: "The event type is a caller input validated at runtime.",
        },
      ],
    });
    expect(built.unresolved).toEqual([]);
    expect(built.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        from: "symbol:packages/runtime/src/dynamic.ts#mutate",
        to: "command:probe.one",
        kind: "invokes-command",
      }),
    ]));
  });
});
