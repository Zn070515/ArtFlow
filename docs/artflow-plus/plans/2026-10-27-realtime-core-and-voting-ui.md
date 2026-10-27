# Realtime Core and Voting UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a reusable WebSocket module (protocol/server/client with protected core) and use it for an Ops voting card with live counts, session orchestration, and result publishing.

**Architecture:** A new `@artflow-plus/realtime` workspace package exposes `/protocol`, `/server`, `/client`. The server registers feature-defined topics and polls their snapshots on an interval; clients reconnect, resubscribe, and fall back to REST polling. The API registers a `voting:<activityId>` topic; the Ops card consumes it and keeps the REST snapshot as the recovery authority.

**Tech Stack:** TypeScript 7, Fastify 5 + `@fastify/websocket` 11 + `ws` 8, TypeBox, Vitest, React 19 + TanStack Query, Playwright.

**Spec:** `docs/artflow-plus/specs/2026-10-27-realtime-core-and-voting-ui-design.md`

---

## File map

| File | Responsibility |
|---|---|
| `plus/packages/realtime/package.json` | Package exports for `/protocol`, `/server`, `/client` |
| `plus/packages/realtime/src/protocol/version.ts` | Version, limits, close codes, heartbeat defaults |
| `plus/packages/realtime/src/protocol/envelope.ts` | TypeBox message schemas + types |
| `plus/packages/realtime/src/protocol/topic.ts` | Actor/target/topic interfaces, grammar, registry |
| `plus/packages/realtime/src/server/hub.ts` | Subscription index, poll loop, fan-out, backpressure |
| `plus/packages/realtime/src/server/connection.ts` | Handshake, frame handling, heartbeat, rate limits |
| `plus/packages/realtime/src/server/plugin.ts` | `createRealtimeServer` Fastify plugin |
| `plus/packages/realtime/src/client/backoff.ts` | Pure exponential backoff with jitter |
| `plus/packages/realtime/src/client/client.ts` | Reconnecting client, resubscribe, fallback |
| `plus/packages/realtime/test/*.test.ts` | Protocol/server/client contract tests |
| `plus/packages/realtime/CORE.md` | Protected-core policy |
| `tests/gates/test_plus_realtime_core.py` | Structural gate + synthetic counterexamples |
| `plus/packages/contracts/src/voting.ts` | `VotingSessionsSnapshotSchema` shared by server/client |
| `plus/packages/runtime/src/voting-read-service.ts` | `readVotingSessionsState` (no permission check) |
| `plus/packages/runtime/src/relay-loop.ts` | Moved `startRelayLoop` (used by worker and inline E2E relay) |
| `plus/apps/api/src/realtime-topics.ts` | `voting` topic registration |
| `plus/apps/api/src/app.ts` | WS registration, REST list route, publishing stages |
| `plus/apps/api/src/main.ts` | `ARTFLOW_PLUS_INLINE_RELAY=1` loop |
| `plus/apps/web/src/realtime/client.ts` | Module-singleton realtime client |
| `plus/apps/web/src/realtime/useRealtimeTopic.ts` | React adapter |
| `plus/apps/web/src/api/voting.ts` | Voting/execution/publishing client functions |
| `plus/apps/web/src/components/ops/VotingCard.tsx` | Voting and publishing card |
| `plus/apps/web/src/routes/opsActivity.tsx` | Render the card |
| `plus/apps/api/scripts/seed-voting.ts` | E2E seed |
| `plus/apps/web/e2e/voting.spec.ts` | E2E with live update |
| `docs/architecture/adr/0027-realtime-core.md` | ADR |
| `docs/invariants/realtime.md` | Core invariants |
| `docs/artflow-plus/roadmap.md` | M11 note |
| `docs/artflow-plus/shape-validation.md` | Voting UI gap closed |

---

## Task 1: Package skeleton, dependencies, and protocol

**Files:**
- Create: `plus/packages/realtime/package.json`
- Create: `plus/packages/realtime/tsconfig.json`
- Create: `plus/packages/realtime/src/protocol/version.ts`
- Create: `plus/packages/realtime/src/protocol/envelope.ts`
- Create: `plus/packages/realtime/src/protocol/topic.ts`
- Create: `plus/packages/realtime/test/protocol.test.ts`

- [ ] **Step 1: Create the package skeleton**

`plus/packages/realtime/package.json`:

```json
{
  "name": "@artflow-plus/realtime",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/protocol/index.ts",
  "types": "./src/protocol/index.ts",
  "exports": {
    "./protocol": {
      "types": "./src/protocol/index.ts",
      "default": "./src/protocol/index.ts"
    },
    "./server": {
      "types": "./src/server/index.ts",
      "default": "./src/server/index.ts"
    },
    "./client": {
      "types": "./src/client/index.ts",
      "default": "./src/client/index.ts"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "check": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@sinclair/typebox": "0.34.52",
    "@fastify/websocket": "11.3.4",
    "ws": "8.22.0"
  },
  "devDependencies": {
    "@types/ws": "8.18.2",
    "fastify": "5.12.7",
    "vitest": "5.0.5"
  },
  "peerDependencies": {
    "fastify": "5.12.7"
  }
}
```

`plus/packages/realtime/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022", "DOM"],
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "rootDir": ".",
    "outDir": "dist",
    "declaration": true,
    "noEmit": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

Create `plus/packages/realtime/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 20_000,
  },
});
```

Install and link:

```powershell
Set-Location "C:\Users\16275\Desktop\ArtFlow\plus"
pnpm install
pnpm --filter @artflow-plus/api add @artflow-plus/realtime@workspace:*
pnpm --filter @artflow-plus/web add @artflow-plus/realtime@workspace:* @artflow-plus/contracts@workspace:*
```

- [ ] **Step 2: Write the failing protocol test**

`plus/packages/realtime/test/protocol.test.ts`:

```ts
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
  ClientMessageSchema,
  ServerMessageSchema,
} from "../src/protocol/envelope.js";
import { createTopicRegistry, parseTopicString } from "../src/protocol/topic.js";

describe("realtime protocol", () => {
  it("accepts the three client messages and rejects unknown types", () => {
    expect(Value.Check(ClientMessageSchema, { v: 1, type: "subscribe", id: "r1", topic: "voting:act-1" })).toBe(true);
    expect(Value.Check(ClientMessageSchema, { v: 1, type: "unsubscribe", id: "r2", topic: "voting:act-1" })).toBe(true);
    expect(Value.Check(ClientMessageSchema, { v: 1, type: "ping", at: 1 })).toBe(true);
    expect(Value.Check(ClientMessageSchema, { v: 1, type: "command", id: "r3" })).toBe(false);
    expect(Value.Check(ClientMessageSchema, { v: 2, type: "ping", at: 1 })).toBe(false);
  });

  it("accepts server frames and rejects mismatched versions", () => {
    expect(Value.Check(ServerMessageSchema, { v: 1, type: "hello", clientPingIntervalMs: 25000, pongTimeoutMs: 10000, maxSubscriptions: 32 })).toBe(true);
    expect(Value.Check(ServerMessageSchema, { v: 1, type: "update", topic: "voting:a", seq: 2, data: {} })).toBe(true);
    expect(Value.Check(ServerMessageSchema, { v: 2, type: "update", topic: "voting:a", seq: 2, data: {} })).toBe(false);
  });

  it("validates the topic grammar", () => {
    expect(parseTopicString("voting:act_123")).toEqual({ namespace: "voting", rest: "act_123" });
    expect(parseTopicString("Voting:act")).toBeNull();
    expect(parseTopicString("voting:")).toBeNull();
    expect(parseTopicString("voting:act 1")).toBeNull();
    expect(parseTopicString("voting:act/1")).toBeNull();
  });

  it("rejects duplicate and invalid namespaces", () => {
    const topic = {
      namespace: "voting",
      parse: () => ({ activityId: "a", aggregateId: "a" }),
      authorize: async () => true,
      snapshot: async () => null,
    };
    expect(() => createTopicRegistry([topic, topic])).toThrow();
    expect(() =>
      createTopicRegistry([{ ...topic, namespace: "Voting" }]),
    ).toThrow();
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

```powershell
Set-Location "C:\Users\16275\Desktop\ArtFlow\plus\packages\realtime"
pnpm exec vitest run test/protocol.test.ts
```
Expected: FAIL — the module files do not exist.

- [ ] **Step 4: Implement the protocol**

`src/protocol/version.ts`:

```ts
export const PROTOCOL_VERSION = 1 as const;

export const LIMITS = {
  maxSubscriptions: 32,
  maxClientMessageBytes: 4096,
  maxServerBufferedBytes: 1024 * 1024,
  subscribePerSecond: 10,
  maxTopicLength: 160,
} as const;

export const HEARTBEAT = {
  clientPingIntervalMs: 25000,
  pongTimeoutMs: 10000,
  serverPingIntervalMs: 30000,
  serverPongTimeoutMs: 10000,
} as const;

export const CLOSE_CODES = {
  normal: 1000,
  protocol: 4400,
  unauthenticated: 4401,
  forbidden: 4403,
  notFound: 4404,
  heartbeatTimeout: 4408,
  limit: 4429,
} as const;

export const REALTIME_ERROR_CODES = [
  "PROTOCOL_INVALID",
  "UNKNOWN_TOPIC",
  "FORBIDDEN",
  "NOT_FOUND",
  "ALREADY_SUBSCRIBED",
  "LIMIT_EXCEEDED",
  "RATE_LIMITED",
  "SNAPSHOT_UNAVAILABLE",
  "VERSION_MISMATCH",
] as const;

export type RealtimeErrorCode = (typeof REALTIME_ERROR_CODES)[number];
```

`src/protocol/envelope.ts`:

```ts
import { Type, type Static } from "@sinclair/typebox";

import { LIMITS, PROTOCOL_VERSION, REALTIME_ERROR_CODES } from "./version.js";

const Version = Type.Literal(PROTOCOL_VERSION);
const RequestId = Type.String({ pattern: "^[A-Za-z0-9_-]{1,64}$" });
const Topic = Type.String({ minLength: 3, maxLength: LIMITS.maxTopicLength });

export const SubscribeMessageSchema = Type.Object(
  { v: Version, type: Type.Literal("subscribe"), id: RequestId, topic: Topic },
  { additionalProperties: false },
);

export const UnsubscribeMessageSchema = Type.Object(
  { v: Version, type: Type.Literal("unsubscribe"), id: RequestId, topic: Topic },
  { additionalProperties: false },
);

export const PingMessageSchema = Type.Object(
  { v: Version, type: Type.Literal("ping"), at: Type.Integer({ minimum: 0 }) },
  { additionalProperties: false },
);

export const ClientMessageSchema = Type.Union([
  SubscribeMessageSchema,
  UnsubscribeMessageSchema,
  PingMessageSchema,
]);

export const HelloMessageSchema = Type.Object(
  {
    v: Version,
    type: Type.Literal("hello"),
    clientPingIntervalMs: Type.Integer({ minimum: 1000 }),
    pongTimeoutMs: Type.Integer({ minimum: 1000 }),
    maxSubscriptions: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

export const SubscribedMessageSchema = Type.Object(
  {
    v: Version,
    type: Type.Literal("subscribed"),
    id: RequestId,
    topic: Topic,
    seq: Type.Integer({ minimum: 0 }),
    data: Type.Unknown(),
  },
  { additionalProperties: false },
);

export const UpdateMessageSchema = Type.Object(
  {
    v: Version,
    type: Type.Literal("update"),
    topic: Topic,
    seq: Type.Integer({ minimum: 0 }),
    data: Type.Unknown(),
  },
  { additionalProperties: false },
);

export const UnsubscribedMessageSchema = Type.Object(
  { v: Version, type: Type.Literal("unsubscribed"), id: RequestId, topic: Topic },
  { additionalProperties: false },
);

export const ErrorMessageSchema = Type.Object(
  {
    v: Version,
    type: Type.Literal("error"),
    id: Type.Optional(RequestId),
    code: Type.Union(REALTIME_ERROR_CODES.map((code) => Type.Literal(code))),
    message: Type.String({ maxLength: 500 }),
  },
  { additionalProperties: false },
);

export const PongMessageSchema = Type.Object(
  { v: Version, type: Type.Literal("pong"), at: Type.Integer({ minimum: 0 }) },
  { additionalProperties: false },
);

export const ServerMessageSchema = Type.Union([
  HelloMessageSchema,
  SubscribedMessageSchema,
  UpdateMessageSchema,
  UnsubscribedMessageSchema,
  ErrorMessageSchema,
  PongMessageSchema,
]);

export type ClientMessage = Static<typeof ClientMessageSchema>;
export type ServerMessage = Static<typeof ServerMessageSchema>;
export type SubscribeMessage = Static<typeof SubscribeMessageSchema>;
export type UnsubscribeMessage = Static<typeof UnsubscribeMessageSchema>;
export type PingMessage = Static<typeof PingMessageSchema>;
export type HelloMessage = Static<typeof HelloMessageSchema>;
export type SubscribedMessage = Static<typeof SubscribedMessageSchema>;
export type UpdateMessage = Static<typeof UpdateMessageSchema>;
export type ErrorMessage = Static<typeof ErrorMessageSchema>;
export type PongMessage = Static<typeof PongMessageSchema>;
```

`src/protocol/topic.ts`:

```ts
import type { TSchema } from "@sinclair/typebox";

import { LIMITS } from "./version.js";

const NAMESPACE_PATTERN = /^[a-z][a-z0-9_]{1,31}$/;
const REST_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

/** The core never imports @artflow-plus/domain; ActorContext is structurally compatible. */
export interface RealtimeActor {
  readonly actorId: string;
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
}

export interface RealtimeTarget {
  readonly topic: string;
  readonly activityId: string;
  readonly aggregateId: string;
}

export interface RealtimeSnapshot {
  readonly seq: number;
  readonly data: unknown;
}

export interface RealtimeTopic {
  readonly namespace: string;
  parse(topic: string): { readonly activityId: string; readonly aggregateId: string } | null;
  authorize(actor: RealtimeActor, target: RealtimeTarget): Promise<boolean>;
  snapshot(target: RealtimeTarget): Promise<RealtimeSnapshot | null>;
  readonly schema?: TSchema;
}

export function parseTopicString(
  topic: string,
): { readonly namespace: string; readonly rest: string } | null {
  if (typeof topic !== "string" || topic.length === 0 || topic.length > LIMITS.maxTopicLength) {
    return null;
  }
  const separator = topic.indexOf(":");
  if (separator < 1 || separator === topic.length - 1) return null;
  const namespace = topic.slice(0, separator);
  const rest = topic.slice(separator + 1);
  if (!NAMESPACE_PATTERN.test(namespace)) return null;
  if (namespace.length > 32) return null;
  if (!REST_PATTERN.test(rest)) return null;
  return { namespace, rest };
}

export function createTopicRegistry(
  topics: readonly RealtimeTopic[],
): ReadonlyMap<string, RealtimeTopic> {
  const registry = new Map<string, RealtimeTopic>();
  for (const topic of topics) {
    if (!NAMESPACE_PATTERN.test(topic.namespace)) {
      throw new Error(`Invalid realtime namespace: ${topic.namespace}`);
    }
    if (registry.has(topic.namespace)) {
      throw new Error(`Duplicate realtime namespace: ${topic.namespace}`);
    }
    registry.set(topic.namespace, topic);
  }
  return registry;
}
```

Create `src/protocol/index.ts`:

```ts
export * from "./envelope.js";
export * from "./topic.js";
export * from "./version.js";
```

Create `src/server/index.ts` and `src/client/index.ts` as empty placeholders for now:

```ts
export {};
```

- [ ] **Step 5: Run the protocol tests**

```powershell
Set-Location "C:\Users\16275\Desktop\ArtFlow\plus\packages\realtime"
pnpm check
pnpm exec vitest run test/protocol.test.ts
```
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```powershell
git add plus/packages/realtime plus/pnpm-lock.yaml plus/apps/api/package.json plus/apps/web/package.json
git commit -m "feat(realtime): add the protocol core"
```

---

## Task 2: Server hub, connection, and plugin

**Files:**
- Create: `plus/packages/realtime/src/server/hub.ts`
- Create: `plus/packages/realtime/src/server/connection.ts`
- Create: `plus/packages/realtime/src/server/plugin.ts`
- Create: `plus/packages/realtime/test/server.test.ts`

- [ ] **Step 1: Write the failing server test**

`plus/packages/realtime/test/server.test.ts`:

```ts
import Fastify from "fastify";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RealtimeConnection } from "../src/server/connection.js";
import { RealtimeHub, shouldSend } from "../src/server/hub.js";
import { createRealtimeServer } from "../src/server/plugin.js";
import type { RealtimeActor, RealtimeTopic } from "../src/protocol/topic.js";
import { CLOSE_CODES, LIMITS } from "../src/protocol/version.js";

const actor: RealtimeActor = {
  actorId: "ops-1",
  roles: ["staff"],
  permissions: ["voting.manage"],
};

function fakeTopic(): RealtimeTopic & { setSeq(seq: number): void } {
  let seq = 0;
  const data = { label: "hello" };
  return {
    namespace: "probe",
    parse: (topic) => {
      const [, rest] = topic.split(":");
      return rest === undefined ? null : { activityId: rest, aggregateId: rest };
    },
    authorize: async () => true,
    snapshot: async () => ({ seq, data }),
    setSeq: (next) => {
      seq = next;
    },
  };
}

async function listen(options: {
  readonly topic?: RealtimeTopic;
  readonly authenticate?: () => Promise<RealtimeActor | null>;
  readonly pollIntervalMs?: number;
}) {
  const app = Fastify({ logger: false });
  const realtime = await createRealtimeServer({
    fastify: app,
    authenticate: options.authenticate ?? (async () => actor),
    topics: [options.topic ?? fakeTopic()],
    pollIntervalMs: options.pollIntervalMs ?? 20,
    heartbeatIntervalMs: 2000,
    heartbeatTimeoutMs: 2000,
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  return { app, realtime, url: `ws://127.0.0.1:${address.port}/api/realtime` };
}

function open(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    inbox(socket); // buffer hello before any assertion attaches
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

interface Inbox {
  readonly queue: any[];
  readonly waiters: { predicate: (message: any) => boolean; resolve: (message: any) => void }[];
}

const inboxes = new WeakMap<WebSocket, Inbox>();

function inbox(socket: WebSocket): Inbox {
  const existing = inboxes.get(socket);
  if (existing !== undefined) return existing;
  const state: Inbox = { queue: [], waiters: [] };
  inboxes.set(socket, state);
  socket.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    const index = state.waiters.findIndex((waiter) => waiter.predicate(message));
    if (index >= 0) {
      const [waiter] = state.waiters.splice(index, 1);
      waiter?.resolve(message);
      return;
    }
    state.queue.push(message);
  });
  return state;
}

/** Buffered matcher: messages that arrive before the assertion are kept. */
function nextMessage(socket: WebSocket, predicate: (message: any) => boolean): Promise<any> {
  const state = inbox(socket);
  const index = state.queue.findIndex(predicate);
  if (index >= 0) return Promise.resolve(state.queue.splice(index, 1)[0]);
  return new Promise((resolve) => state.waiters.push({ predicate, resolve }));
}

describe("realtime server", () => {
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
  });

  it("closes unauthenticated connections with 4401", async () => {
    const { app, realtime, url } = await listen({ authenticate: async () => null });
    closers.push(async () => {
      await realtime.close();
      await app.close();
    });
    const socket = new WebSocket(url);
    const code = await new Promise<number>((resolve) => socket.once("close", resolve));
    expect(code).toBe(CLOSE_CODES.unauthenticated);
  });

  it("sends hello, a snapshot, updates, and pongs", async () => {
    const topic = fakeTopic();
    const { app, realtime, url } = await listen({ topic });
    closers.push(async () => {
      await realtime.close();
      await app.close();
    });
    const socket = await open(url);
    expect((await nextMessage(socket, (m) => m.type === "hello")).v).toBe(1);

    socket.send(JSON.stringify({ v: 1, type: "subscribe", id: "s1", topic: "probe:act-1" }));
    const subscribed = await nextMessage(socket, (m) => m.type === "subscribed");
    expect(subscribed).toMatchObject({ id: "s1", topic: "probe:act-1", seq: 0 });

    topic.setSeq(1);
    const update = await nextMessage(socket, (m) => m.type === "update");
    expect(update).toMatchObject({ seq: 1 });

    socket.send(JSON.stringify({ v: 1, type: "ping", at: 5 }));
    expect(await nextMessage(socket, (m) => m.type === "pong")).toMatchObject({ at: 5 });
    socket.close();
  });

  it("reports unknown topics and forbidden subscriptions without closing", async () => {
    const denying: RealtimeTopic = {
      ...fakeTopic(),
      namespace: "deny",
      authorize: async () => false,
    };
    const { app, realtime, url } = await listen({ topic: denying });
    closers.push(async () => {
      await realtime.close();
      await app.close();
    });
    const socket = await open(url);
    await nextMessage(socket, (m) => m.type === "hello");

    socket.send(JSON.stringify({ v: 1, type: "subscribe", id: "s1", topic: "unknown:act" }));
    expect(await nextMessage(socket, (m) => m.type === "error")).toMatchObject({ code: "UNKNOWN_TOPIC" });

    socket.send(JSON.stringify({ v: 1, type: "subscribe", id: "s2", topic: "deny:act" }));
    expect(await nextMessage(socket, (m) => m.type === "error")).toMatchObject({ code: "FORBIDDEN" });

    socket.send(JSON.stringify({ v: 1, type: "ping", at: 1 }));
    expect(await nextMessage(socket, (m) => m.type === "pong")).toBeTruthy();
    socket.close();
  });

  it("drops stale sequence updates and stops after unsubscribe", async () => {
    const topic = fakeTopic();
    const { app, realtime, url } = await listen({ topic });
    closers.push(async () => {
      await realtime.close();
      await app.close();
    });
    const socket = await open(url);
    await nextMessage(socket, (m) => m.type === "hello");
    socket.send(JSON.stringify({ v: 1, type: "subscribe", id: "s1", topic: "probe:act-1" }));
    await nextMessage(socket, (m) => m.type === "subscribed");

    topic.setSeq(1);
    await nextMessage(socket, (m) => m.type === "update" && m.seq === 1);
    let sawStale = false;
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === "update" && message.seq <= 1) sawStale = true;
    });
    topic.setSeq(1);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(sawStale).toBe(false);

    socket.send(JSON.stringify({ v: 1, type: "unsubscribe", id: "u1", topic: "probe:act-1" }));
    await nextMessage(socket, (m) => m.type === "unsubscribed");
    topic.setSeq(2);
    let sawUpdate = false;
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === "update") sawUpdate = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(sawUpdate).toBe(false);
    socket.close();
  });

  it("drops updates when the send buffer is full", () => {
    expect(shouldSend(0)).toBe(true);
    expect(shouldSend(LIMITS.maxServerBufferedBytes)).toBe(true);
    expect(shouldSend(LIMITS.maxServerBufferedBytes + 1)).toBe(false);
  });

  it("terminates a connection that misses a pong", () => {
    const socket = {
      readyState: 1,
      bufferedAmount: 0,
      ping: vi.fn(),
      terminate: vi.fn(),
      close: vi.fn(),
      on: vi.fn(),
      send: vi.fn(),
    } as unknown as WebSocket;
    const logger = { error: () => {}, info: () => {} };
    const hub = new RealtimeHub({ pollIntervalMs: 1000, logger });
    const connection = new RealtimeConnection(socket, actor, new Map(), hub, logger, "c1");
    connection.ping();
    connection.checkAlive();
    expect(socket.terminate).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```powershell
Set-Location "C:\Users\16275\Desktop\ArtFlow\plus\packages\realtime"
pnpm exec vitest run test/server.test.ts
```
Expected: FAIL — `createRealtimeServer` is missing.

- [ ] **Step 3: Implement the hub**

`src/server/hub.ts`:

```ts
import { Value } from "@sinclair/typebox/value";
import type { TSchema } from "@sinclair/typebox";

import type { ServerMessage } from "../protocol/envelope.js";
import type { RealtimeTarget, RealtimeTopic } from "../protocol/topic.js";
import { LIMITS, PROTOCOL_VERSION } from "../protocol/version.js";

export interface RealtimePeer {
  readonly id: string;
  readonly bufferedAmount: number;
  send(message: ServerMessage): void;
}

interface Subscriber {
  readonly peer: RealtimePeer;
  lastSeq: number;
}

interface TopicState {
  readonly definition: RealtimeTopic;
  readonly target: RealtimeTarget;
  readonly subscribers: Map<string, Subscriber>;
}

export interface RealtimeLogger {
  error(payload: unknown, message?: string): void;
  info(payload: unknown, message?: string): void;
}

export function shouldSend(
  bufferedAmount: number,
  maxBytes: number = LIMITS.maxServerBufferedBytes,
): boolean {
  return bufferedAmount <= maxBytes;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`snapshot timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class RealtimeHub {
  private readonly topics = new Map<string, TopicState>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly options: {
      readonly pollIntervalMs: number;
      readonly logger: RealtimeLogger;
    },
  ) {}

  add(
    peer: RealtimePeer,
    definition: RealtimeTopic,
    target: RealtimeTarget,
    seq: number,
  ): void {
    let state = this.topics.get(target.topic);
    if (state === undefined) {
      state = { definition, target, subscribers: new Map() };
      this.topics.set(target.topic, state);
    }
    state.subscribers.set(peer.id, { peer, lastSeq: seq });
  }

  remove(peerId: string): void {
    for (const [topic, state] of this.topics) {
      state.subscribers.delete(peerId);
      if (state.subscribers.size === 0) this.topics.delete(topic);
    }
  }

  removeTopic(peerId: string, topic: string): void {
    const state = this.topics.get(topic);
    if (state === undefined) return;
    state.subscribers.delete(peerId);
    if (state.subscribers.size === 0) this.topics.delete(topic);
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.options.pollIntervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.topics.clear();
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await Promise.all([...this.topics.values()].map((state) => this.poll(state)));
    } finally {
      this.running = false;
    }
  }

  private async poll(state: TopicState): Promise<void> {
    try {
      const snapshot = await withTimeout(state.definition.snapshot(state.target), 2000);
      if (snapshot === null) return;
      if (state.definition.schema !== undefined) {
        const schema: TSchema = state.definition.schema;
        if (!Value.Check(schema, snapshot.data)) {
          this.options.logger.error(
            { topic: state.target.topic },
            "realtime snapshot failed its schema; refusing to send",
          );
          return;
        }
      }
      for (const subscriber of state.subscribers.values()) {
        if (snapshot.seq <= subscriber.lastSeq) continue;
        if (!shouldSend(subscriber.peer.bufferedAmount)) continue;
        subscriber.peer.send({
          v: PROTOCOL_VERSION,
          type: "update",
          topic: state.target.topic,
          seq: snapshot.seq,
          data: snapshot.data,
        });
        subscriber.lastSeq = snapshot.seq;
      }
    } catch (error) {
      this.options.logger.error(
        { topic: state.target.topic, error },
        "realtime snapshot failed",
      );
    }
  }
}
```

- [ ] **Step 4: Implement the connection**

`src/server/connection.ts`:

```ts
import { Value } from "@sinclair/typebox/value";
import type { WebSocket } from "ws";

import {
  ClientMessageSchema,
  type ClientMessage,
  type ServerMessage,
} from "../protocol/envelope.js";
import type { RealtimeTarget, RealtimeTopic } from "../protocol/topic.js";
import { parseTopicString } from "../protocol/topic.js";
import {
  CLOSE_CODES,
  HEARTBEAT,
  LIMITS,
  PROTOCOL_VERSION,
  type RealtimeErrorCode,
} from "../protocol/version.js";
import { RealtimeHub } from "./hub.js";
import type { RealtimeLogger, RealtimePeer } from "./hub.js";
import type { RealtimeActor } from "../protocol/topic.js";

interface Subscription {
  readonly definition: RealtimeTopic;
  readonly target: RealtimeTarget;
}

const OPEN_STATE = 1;

export class RealtimeConnection implements RealtimePeer {
  readonly id: string;
  private readonly subscriptions = new Map<string, Subscription>();
  private alive = true;
  private violations = 0;
  private subscribeTokens = LIMITS.subscribePerSecond;
  private readonly tokenTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly socket: WebSocket,
    private readonly actor: RealtimeActor,
    private readonly topics: ReadonlyMap<string, RealtimeTopic>,
    private readonly hub: RealtimeHub,
    private readonly logger: RealtimeLogger,
    id: string,
  ) {
    this.id = id;
    this.tokenTimer = setInterval(() => {
      this.subscribeTokens = LIMITS.subscribePerSecond;
    }, 1000);
    this.tokenTimer.unref?.();
  }

  get bufferedAmount(): number {
    return this.socket.bufferedAmount;
  }

  start(): void {
    this.send({
      v: PROTOCOL_VERSION,
      type: "hello",
      clientPingIntervalMs: HEARTBEAT.clientPingIntervalMs,
      pongTimeoutMs: HEARTBEAT.pongTimeoutMs,
      maxSubscriptions: LIMITS.maxSubscriptions,
    });
    this.socket.on("message", (raw) => {
      void this.onMessage(raw);
    });
    this.socket.on("pong", () => {
      this.alive = true;
    });
    this.socket.on("close", () => {
      clearInterval(this.tokenTimer);
      this.hub.remove(this.id);
    });
  }

  send(message: ServerMessage): void {
    if (this.socket.readyState !== OPEN_STATE) return;
    this.socket.send(JSON.stringify(message));
  }

  ping(): void {
    this.alive = false;
    this.socket.ping();
  }

  checkAlive(): void {
    if (this.alive) return;
    this.socket.close(CLOSE_CODES.heartbeatTimeout, "heartbeat timeout");
    this.socket.terminate();
  }

  close(code: number, reason: string): void {
    this.socket.close(code, reason);
  }

  private error(id: string | undefined, code: RealtimeErrorCode, message: string): void {
    this.send({ v: PROTOCOL_VERSION, type: "error", ...(id === undefined ? {} : { id }), code, message });
  }

  private protocolViolation(): void {
    this.violations += 1;
    if (this.violations >= 3) {
      this.socket.close(CLOSE_CODES.protocol, "protocol violation");
    }
  }

  private async onMessage(raw: unknown): Promise<void> {
    let message: ClientMessage;
    try {
      const text = String(raw);
      if (Buffer.byteLength(text, "utf8") > LIMITS.maxClientMessageBytes) {
        this.protocolViolation();
        return;
      }
      const parsed: unknown = JSON.parse(text);
      if (!Value.Check(ClientMessageSchema, parsed)) {
        this.error(undefined, "PROTOCOL_INVALID", "malformed client message");
        this.protocolViolation();
        return;
      }
      message = parsed;
    } catch {
      this.error(undefined, "PROTOCOL_INVALID", "malformed client message");
      this.protocolViolation();
      return;
    }

    if (message.type === "ping") {
      this.send({ v: PROTOCOL_VERSION, type: "pong", at: message.at });
      return;
    }
    if (message.type === "unsubscribe") {
      this.subscriptions.delete(message.topic);
      this.hub.removeTopic(this.id, message.topic);
      this.send({ v: PROTOCOL_VERSION, type: "unsubscribed", id: message.id, topic: message.topic });
      return;
    }
    await this.subscribe(message.id, message.topic);
  }

  private async subscribe(id: string, topic: string): Promise<void> {
    if (this.subscribeTokens <= 0) {
      this.error(id, "RATE_LIMITED", "subscribe rate exceeded");
      this.socket.close(CLOSE_CODES.limit, "subscribe rate exceeded");
      return;
    }
    this.subscribeTokens -= 1;

    if (this.subscriptions.has(topic)) {
      this.error(id, "ALREADY_SUBSCRIBED", "already subscribed");
      return;
    }
    if (this.subscriptions.size >= LIMITS.maxSubscriptions) {
      this.error(id, "LIMIT_EXCEEDED", "subscription limit reached");
      this.socket.close(CLOSE_CODES.limit, "subscription limit reached");
      return;
    }
    const parsed = parseTopicString(topic);
    if (parsed === null) {
      this.error(id, "UNKNOWN_TOPIC", "invalid topic");
      return;
    }
    const definition = this.topics.get(parsed.namespace);
    if (definition === undefined) {
      this.error(id, "UNKNOWN_TOPIC", "unknown namespace");
      return;
    }
    const target = definition.parse(topic);
    if (target === null) {
      this.error(id, "UNKNOWN_TOPIC", "topic not found");
      return;
    }
    if (!(await definition.authorize(this.actor, { topic, ...target }))) {
      this.error(id, "FORBIDDEN", "not allowed to subscribe");
      return;
    }
    let snapshot;
    try {
      snapshot = await definition.snapshot({ topic, ...target });
    } catch (error) {
      this.logger.error({ topic, error }, "snapshot failed on subscribe");
      this.error(id, "SNAPSHOT_UNAVAILABLE", "snapshot unavailable");
      return;
    }
    if (snapshot === null) {
      this.error(id, "SNAPSHOT_UNAVAILABLE", "snapshot unavailable");
      return;
    }
    if (definition.schema !== undefined && !Value.Check(definition.schema, snapshot.data)) {
      this.logger.error({ topic }, "snapshot failed its schema; refusing to subscribe");
      this.error(id, "SNAPSHOT_UNAVAILABLE", "snapshot unavailable");
      return;
    }
    this.subscriptions.set(topic, { definition, target: { topic, ...target } });
    this.hub.add(this, definition, { topic, ...target }, snapshot.seq);
    this.send({
      v: PROTOCOL_VERSION,
      type: "subscribed",
      id,
      topic,
      seq: snapshot.seq,
      data: snapshot.data,
    });
  }
}
```

- [ ] **Step 5: Implement the plugin**

`src/server/plugin.ts`:

```ts
import websocket from "@fastify/websocket";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";

import type { RealtimeActor, RealtimeTopic } from "../protocol/topic.js";
import { createTopicRegistry } from "../protocol/topic.js";
import { CLOSE_CODES, HEARTBEAT, LIMITS } from "../protocol/version.js";
import { RealtimeConnection } from "./connection.js";
import { RealtimeHub } from "./hub.js";
import type { RealtimeLogger } from "./hub.js";

export interface RealtimeServerOptions {
  readonly fastify: FastifyInstance;
  readonly path?: string;
  readonly authenticate: (request: FastifyRequest) => Promise<RealtimeActor | null>;
  readonly topics: readonly RealtimeTopic[];
  readonly pollIntervalMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly heartbeatTimeoutMs?: number;
}

export interface RealtimeHandle {
  close(): Promise<void>;
}

export async function createRealtimeServer(
  options: RealtimeServerOptions,
): Promise<RealtimeHandle> {
  const registry = createTopicRegistry(options.topics);
  const logger: RealtimeLogger = {
    error: (payload, message) => options.fastify.log.error(payload, message),
    info: (payload, message) => options.fastify.log.info(payload, message),
  };
  const hub = new RealtimeHub({
    pollIntervalMs: options.pollIntervalMs ?? 1000,
    logger,
  });
  const connections = new Set<RealtimeConnection>();

  await options.fastify.register(websocket, {
    options: { maxPayload: LIMITS.maxClientMessageBytes },
  });

  options.fastify.get(
    options.path ?? "/api/realtime",
    { websocket: true },
    (socket, request) => {
      void (async () => {
        socket.pause();
        let actor: RealtimeActor | null = null;
        try {
          actor = await options.authenticate(request);
        } catch {
          actor = null;
        }
        if (actor === null) {
          // Resume before closing: a paused socket never reads the peer's close
          // reply, so the handshake would otherwise wait for the close timeout.
          socket.resume();
          socket.close(CLOSE_CODES.unauthenticated, "unauthenticated");
          return;
        }
        const connection = new RealtimeConnection(
          socket,
          actor,
          registry,
          hub,
          logger,
          randomUUID(),
        );
        connections.add(connection);
        socket.once("close", () => {
          connections.delete(connection);
        });
        connection.start();
        socket.resume();
      })();
    },
  );

  hub.start();
  const pingTimer = setInterval(() => {
    for (const connection of connections) connection.ping();
  }, options.heartbeatIntervalMs ?? HEARTBEAT.serverPingIntervalMs);
  pingTimer.unref?.();
  const aliveTimer = setInterval(() => {
    for (const connection of connections) connection.checkAlive();
  }, options.heartbeatTimeoutMs ?? HEARTBEAT.serverPongTimeoutMs);
  aliveTimer.unref?.();

  return {
    async close(): Promise<void> {
      clearInterval(pingTimer);
      clearInterval(aliveTimer);
      await hub.stop();
      for (const connection of connections) connection.close(1000, "server shutdown");
    },
  };
}
```

The `RealtimeConnection.close` method doesn't exist; add:

```ts
  close(code: number, reason: string): void {
    this.socket.close(code, reason);
  }
```

The plugin runs two intervals: one sends ws pings every `heartbeatIntervalMs`, the other
terminates connections that missed a pong after `heartbeatTimeoutMs`.

- [ ] **Step 6: Run the server tests**

```powershell
pnpm check
pnpm exec vitest run test/server.test.ts
```
Expected: PASS (6 tests).

- [ ] **Step 7: Commit**

```powershell
git add plus/packages/realtime/src/server plus/packages/realtime/test/server.test.ts
git commit -m "feat(realtime): add the server core"
```

---

## Task 3: Client core and reconnect

**Files:**
- Create: `plus/packages/realtime/src/client/backoff.ts`
- Create: `plus/packages/realtime/src/client/client.ts`
- Create: `plus/packages/realtime/src/client/index.ts`
- Create: `plus/packages/realtime/test/client.test.ts`

- [ ] **Step 1: Write the failing client tests**

`plus/packages/realtime/test/client.test.ts`:

```ts
import Fastify from "fastify";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { createRealtimeClient } from "../src/client/client.js";
import { nextBackoff } from "../src/client/backoff.js";
import { createRealtimeServer } from "../src/server/plugin.js";
import type { RealtimeActor, RealtimeTopic } from "../src/protocol/topic.js";

const actor: RealtimeActor = {
  actorId: "ops-1",
  roles: ["staff"],
  permissions: ["voting.manage"],
};

function topic(seqRef: { value: number }): RealtimeTopic {
  return {
    namespace: "probe",
    parse: (value) => {
      const rest = value.split(":")[1];
      return rest === undefined ? null : { activityId: rest, aggregateId: rest };
    },
    authorize: async () => true,
    snapshot: async () => ({ seq: seqRef.value, data: { seq: seqRef.value } }),
  };
}

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("client backoff", () => {
  it("grows exponentially and respects the cap with jitter", () => {
    expect(nextBackoff(0, () => 0.5)).toBe(500);
    expect(nextBackoff(1, () => 0.5)).toBe(1000);
    expect(nextBackoff(4, () => 0.5)).toBe(8000);
    expect(nextBackoff(20, () => 0.5)).toBe(15000);
    expect(nextBackoff(0, () => 1)).toBe(600);
    expect(nextBackoff(0, () => 0)).toBe(400);
  });
});

describe("realtime client", () => {
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
  });

  it("receives a snapshot, updates, and reports fallback recovery", async () => {
    const seq = { value: 0 };
    const app = Fastify({ logger: false });
    const server = await createRealtimeServer({
      fastify: app,
      authenticate: async () => actor,
      topics: [topic(seq)],
      pollIntervalMs: 20,
      heartbeatIntervalMs: 1000,
      heartbeatTimeoutMs: 1000,
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === "string") throw new Error("no address");
    const client = createRealtimeClient({ url: `ws://127.0.0.1:${address.port}/api/realtime` });
    const values: number[] = [];
    client.subscribe<{ seq: number }>("probe:act-1", {
      onSnapshot: (data) => values.push(data.seq),
      onUpdate: (data) => values.push(data.seq),
    });
    closers.push(async () => {
      client.close();
      await server.close();
      await app.close();
    });

    await waitFor(() => values.length === 1);
    expect(values[0]).toBe(0);
    seq.value = 1;
    await waitFor(() => values.includes(1));
  });

  it("reconnects after an unauthenticated first handshake", async () => {
    const seq = { value: 0 };
    const app = Fastify({ logger: false });
    let attempts = 0;
    const server = await createRealtimeServer({
      fastify: app,
      authenticate: async () => {
        attempts += 1;
        return attempts === 1 ? null : actor;
      },
      topics: [topic(seq)],
      pollIntervalMs: 20,
      heartbeatIntervalMs: 1000,
      heartbeatTimeoutMs: 1000,
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === "string") throw new Error("no address");
    const fallbacks: boolean[] = [];
    const client = createRealtimeClient({
      url: `ws://127.0.0.1:${address.port}/api/realtime`,
      onFallbackChange: (fallback) => fallbacks.push(fallback),
    });
    const values: number[] = [];
    client.subscribe<{ seq: number }>("probe:act-1", {
      onSnapshot: (data) => values.push(data.seq),
      onUpdate: (data) => values.push(data.seq),
    });
    closers.push(async () => {
      client.close();
      await server.close();
      await app.close();
    });

    await waitFor(() => values.length === 1, 5000);
    expect(fallbacks).toContain(true);
    expect(fallbacks.at(-1)).toBe(false);
  });

  it("closes and reconnects when pongs stop", async () => {
    const raw = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    let connections = 0;
    raw.on("connection", (socket) => {
      connections += 1;
      socket.send(JSON.stringify({
        v: 1,
        type: "hello",
        clientPingIntervalMs: 1000,
        pongTimeoutMs: 1000,
        maxSubscriptions: 32,
      }));
    });
    const port = (raw.address() as { port: number }).port;
    const client = createRealtimeClient({
      url: `ws://127.0.0.1:${port}`,
      pingIntervalMs: 1000,
      pongTimeoutMs: 1000,
    });
    client.subscribe("probe:act-1", { onSnapshot: () => {}, onUpdate: () => {} });
    await waitFor(() => connections >= 2, 6000);
    client.close();
    await new Promise<void>((resolve) => raw.close(() => resolve()));
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```powershell
Set-Location "C:\Users\16275\Desktop\ArtFlow\plus\packages\realtime"
pnpm exec vitest run test/client.test.ts
```
Expected: FAIL — the client modules do not exist.

- [ ] **Step 3: Implement the client**

`src/client/backoff.ts`:

```ts
export function nextBackoff(
  attempt: number,
  random: () => number = Math.random,
  maxMs = 15000,
): number {
  const base = Math.min(500 * 2 ** Math.max(0, attempt), maxMs);
  const jitter = base * 0.2 * (random() * 2 - 1);
  return Math.max(100, Math.round(base + jitter));
}
```

`src/client/client.ts`:

```ts
import { Value } from "@sinclair/typebox/value";

import { ServerMessageSchema } from "../protocol/envelope.js";
import type { ClientMessage, ServerMessage } from "../protocol/envelope.js";
import { HEARTBEAT, PROTOCOL_VERSION } from "../protocol/version.js";
import { nextBackoff } from "./backoff.js";

export interface RealtimeSubscriptionHandlers<T> {
  onSnapshot(data: T, seq: number): void;
  onUpdate(data: T, seq: number): void;
  onError?(error: { code: string; message: string }): void;
}

export interface RealtimeClientOptions {
  readonly url?: string;
  readonly pingIntervalMs?: number;
  readonly pongTimeoutMs?: number;
  readonly maxBackoffMs?: number;
  readonly onFallbackChange?: (fallback: boolean) => void;
}

export interface RealtimeClient {
  subscribe<T>(topic: string, handlers: RealtimeSubscriptionHandlers<T>): () => void;
  onFallbackChange(listener: (fallback: boolean) => void): () => void;
  close(): void;
}

function requestId(): string {
  return `r-${Math.random().toString(36).slice(2, 10)}`;
}

export function createRealtimeClient(options: RealtimeClientOptions = {}): RealtimeClient {
  const url = options.url ?? "/api/realtime";
  const listeners = new Set<(fallback: boolean) => void>();
  const subs = new Map<string, Set<RealtimeSubscriptionHandlers<unknown>>>();
  const lastSeq = new Map<string, number>();
  const pending = new Map<string, string>();
  let socket: WebSocket | null = null;
  let helloReceived = false;
  let fallback = false;
  let fatal = false;
  let closed = false;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let pongTimer: ReturnType<typeof setTimeout> | null = null;
  let pingIntervalMs = options.pingIntervalMs ?? HEARTBEAT.clientPingIntervalMs;
  let pongTimeoutMs = options.pongTimeoutMs ?? HEARTBEAT.pongTimeoutMs;

  function setFallback(next: boolean): void {
    if (fallback === next) return;
    fallback = next;
    options.onFallbackChange?.(next);
    for (const listener of listeners) listener(next);
  }

  function send(message: ClientMessage): void {
    if (socket === null || socket.readyState !== 1) return;
    socket.send(JSON.stringify(message));
  }

  function clearTimers(): void {
    if (pingTimer !== null) clearInterval(pingTimer);
    if (pongTimer !== null) clearTimeout(pongTimer);
    pingTimer = null;
    pongTimer = null;
  }

  function scheduleReconnect(): void {
    if (closed || fatal || reconnectTimer !== null) return;
    setFallback(true);
    const delay = nextBackoff(attempt, Math.random, options.maxBackoffMs);
    attempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function dispatch(message: ServerMessage): void {
    if (message.type === "hello") {
      helloReceived = true;
      attempt = 0;
      pingIntervalMs = options.pingIntervalMs ?? message.clientPingIntervalMs;
      pongTimeoutMs = options.pongTimeoutMs ?? message.pongTimeoutMs;
      setFallback(false);
      // A restarted server may restart sequence numbers; drop stale cursors.
      lastSeq.clear();
      pending.clear();
      for (const topic of subs.keys()) {
        const id = requestId();
        pending.set(id, topic);
        send({ v: PROTOCOL_VERSION, type: "subscribe", id, topic });
      }
      startPing();
      return;
    }
    if (message.type === "pong") {
      if (pongTimer !== null) clearTimeout(pongTimer);
      pongTimer = null;
      return;
    }
    if (message.type === "error") {
      if (message.code === "VERSION_MISMATCH") {
        fatal = true;
        setFallback(true);
        socket?.close();
        return;
      }
      if (message.id !== undefined) {
        const topic = pending.get(message.id);
        pending.delete(message.id);
        if (topic !== undefined) {
          for (const handler of subs.get(topic) ?? []) {
            handler.onError?.({ code: message.code, message: message.message });
          }
        }
      }
      return;
    }
    if (message.type === "subscribed") {
      pending.delete(message.id);
      const subscribers = subs.get(message.topic);
      if (subscribers === undefined) return;
      lastSeq.set(message.topic, message.seq);
      for (const handler of subscribers) handler.onSnapshot(message.data, message.seq);
      return;
    }
    if (message.type === "update") {
      const subscribers = subs.get(message.topic);
      if (subscribers === undefined) return;
      const previous = lastSeq.get(message.topic) ?? -1;
      if (message.seq <= previous) return;
      lastSeq.set(message.topic, message.seq);
      for (const handler of subscribers) handler.onUpdate(message.data, message.seq);
    }
  }

  function startPing(): void {
    clearTimers();
    pingTimer = setInterval(() => {
      if (socket === null || socket.readyState !== 1) return;
      send({ v: PROTOCOL_VERSION, type: "ping", at: Date.now() });
      if (pongTimer !== null) clearTimeout(pongTimer);
      pongTimer = setTimeout(() => {
        pongTimer = null;
        socket?.close();
      }, pongTimeoutMs);
    }, pingIntervalMs);
  }

  function connect(): void {
    if (closed || fatal || socket !== null) return;
    helloReceived = false;
    let next: WebSocket;
    try {
      next = new WebSocket(url);
    } catch {
      setFallback(true);
      scheduleReconnect();
      return;
    }
    socket = next;
    next.onmessage = (event) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if ((parsed as { v?: unknown } | null)?.v !== PROTOCOL_VERSION) {
        fatal = true;
        setFallback(true);
        next.close();
        return;
      }
      if (!Value.Check(ServerMessageSchema, parsed)) return;
      if (pongTimer !== null) {
        clearTimeout(pongTimer);
        pongTimer = null;
      }
      dispatch(parsed);
    };
    next.onclose = () => {
      clearTimers();
      socket = null;
      helloReceived = false;
      if (!closed && !fatal) scheduleReconnect();
    };
    next.onerror = () => {
      next.close();
    };
  }

  return {
    subscribe<T>(topic: string, handlers: RealtimeSubscriptionHandlers<T>): () => void {
      const stored = handlers as RealtimeSubscriptionHandlers<unknown>;
      const existing = subs.get(topic);
      const first = existing === undefined || existing.size === 0;
      if (existing === undefined) subs.set(topic, new Set([stored]));
      else existing.add(stored);
      if (socket === null) connect();
      else if (helloReceived && first) {
        const id = requestId();
        pending.set(id, topic);
        send({ v: PROTOCOL_VERSION, type: "subscribe", id, topic });
      }
      return () => {
        const current = subs.get(topic);
        if (current === undefined) return;
        current.delete(stored);
        if (current.size > 0) return;
        subs.delete(topic);
        lastSeq.delete(topic);
        send({ v: PROTOCOL_VERSION, type: "unsubscribe", id: requestId(), topic });
      };
    },
    onFallbackChange(listener: (fallback: boolean) => void): () => void {
      listeners.add(listener);
      listener(fallback);
      return () => listeners.delete(listener);
    },
    close(): void {
      closed = true;
      clearTimers();
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      socket?.close();
      socket = null;
      subs.clear();
      listeners.clear();
    },
  };
}
```

`src/client/index.ts`:

```ts
export * from "./backoff.js";
export * from "./client.js";
```

Fix the server test helper (buffered collector) and the connection issues from Task 2 before moving on — these are addressed in the self-review section at the end of the plan.

- [ ] **Step 4: Run the client tests**

```powershell
Set-Location "C:\Users\16275\Desktop\ArtFlow\plus\packages\realtime"
pnpm check
pnpm exec vitest run test/client.test.ts
```
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```powershell
git add plus/packages/realtime/src/client plus/packages/realtime/test/client.test.ts
git commit -m "feat(realtime): add the reconnecting client"
```

---

## Task 4: Structural gate and CORE.md

**Files:**
- Create: `plus/packages/realtime/CORE.md`
- Create: `tests/gates/test_plus_realtime_core.py`

- [ ] **Step 1: Write the failing gate test**

`tests/gates/test_plus_realtime_core.py`:

```python
from __future__ import annotations

import re
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
PLUS_ROOT = PROJECT_ROOT / "plus"
REALTIME_ROOT = PLUS_ROOT / "packages" / "realtime"
CLIENT_ROOT = REALTIME_ROOT / "src" / "client"
CONSTRUCTOR_ROOTS = (CLIENT_ROOT, REALTIME_ROOT / "test")

TRANSPORT_IMPORT = re.compile(r'from\s+"(ws|@fastify/websocket)"')
WEBSOCKET_CONSTRUCTOR = re.compile(r"\bnew\s+WebSocket\s*\(")
FORBIDDEN_CORE_IMPORT = re.compile(
    r'from\s+"@artflow-plus/(domain|db|runtime)(?:/[^"]*)?"'
)


def _ts_files(root: Path) -> list[Path]:
    return [
        path
        for path in root.rglob("*.ts")
        if "node_modules" not in path.parts and "dist" not in path.parts
    ]


def _transport_violations(root: Path) -> list[str]:
    violations: list[str] = []
    for path in _ts_files(root):
        if REALTIME_ROOT in path.parents:
            continue
        text = path.read_text(encoding="utf-8")
        if TRANSPORT_IMPORT.search(text):
            violations.append(str(path.relative_to(root)))
    return violations


def _constructor_violations(root: Path) -> list[str]:
    violations: list[str] = []
    for path in _ts_files(root):
        if any(allowed in path.parents for allowed in CONSTRUCTOR_ROOTS):
            continue
        text = path.read_text(encoding="utf-8")
        if WEBSOCKET_CONSTRUCTOR.search(text):
            violations.append(str(path.relative_to(root)))
    return violations


def _core_import_violations(root: Path) -> list[str]:
    violations: list[str] = []
    for path in _ts_files(root / "packages" / "realtime"):
        text = path.read_text(encoding="utf-8")
        if FORBIDDEN_CORE_IMPORT.search(text):
            violations.append(str(path.relative_to(root)))
    return violations


def test_transport_imports_are_confined_to_the_realtime_package() -> None:
    assert _transport_violations(PLUS_ROOT) == []


def test_websocket_constructor_is_confined_to_the_client_module() -> None:
    assert _constructor_violations(PLUS_ROOT) == []


def test_realtime_core_does_not_import_business_packages() -> None:
    assert _core_import_violations(PLUS_ROOT) == []


def test_gate_detects_synthetic_violations(tmp_path: Path) -> None:
    package = tmp_path / "packages" / "realtime"
    package.mkdir(parents=True)
    outside = tmp_path / "apps" / "api"
    outside.mkdir(parents=True)
    (outside / "bad.ts").write_text(
        'import ws from "ws";\nconst socket = new WebSocket("ws://x");\n',
        encoding="utf-8",
    )
    assert _transport_violations(tmp_path) == ["apps/api/bad.ts"]
    assert _constructor_violations(tmp_path) == ["apps/api/bad.ts"]

    (package / "bad-core.ts").write_text(
        'import { DomainError } from "@artflow-plus/domain";\n',
        encoding="utf-8",
    )
    assert _core_import_violations(tmp_path) == ["packages/realtime/bad-core.ts"]
```

- [ ] **Step 2: Run it and confirm it fails**

```powershell
Set-Location "C:\Users\16275\Desktop\ArtFlow"
$env:PYTHONIOENCODING="utf-8"
uv run pytest tests/gates/test_plus_realtime_core.py -q
```
Expected: FAIL on the real-repo tests (the `ws` import exists outside until the layout is correct? At this point the realtime package exists and imports ws inside it, so the transport test passes; the constructor test passes; the core import test passes; only the synthetic test may pass). If all pass, that is fine — the gate is already green because the code respects it; proceed. The synthetic case proves it detects violations.

- [ ] **Step 3: Write CORE.md**

`plus/packages/realtime/CORE.md`:

```md
# Realtime core — protected contract

This package owns the only WebSocket implementation in the repository.

## Non-negotiable

1. Notification-only: clients may send `subscribe`, `unsubscribe`, `ping`. No business
   commands travel over the socket.
2. Handshake authentication and per-topic authorization. Never trust activity or
   permission fields from the client.
3. Snapshot first, then full snapshots only. `seq` is monotonic per topic; clients drop
   `seq <= last`.
4. Bounded connections: max 32 subscriptions, 4 KiB client frames, 1 MiB send buffer,
   10 subscribe requests per second. Under backpressure, drop updates; never queue.
5. Heartbeat liveness on both ends.
6. Versioned envelope; incompatible changes bump `PROTOCOL_VERSION`.
7. Only this package imports `ws` / `@fastify/websocket`; only `src/client` and this
   package's own tests construct `WebSocket`.
8. This package never imports `@artflow-plus/domain`, `@artflow-plus/db`, or
   `@artflow-plus/runtime`.

## Changing the core

- Any change to the rules above requires an ADR and a matching contract test update.
- Feature work registers `RealtimeTopic` definitions; it must not fork the connection,
  reconnect, heartbeat, or envelope code.
- `tests/gates/test_plus_realtime_core.py` enforces the import boundaries.
```

- [ ] **Step 4: Run the gate**

```powershell
uv run pytest tests/gates/test_plus_realtime_core.py -q
```
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```powershell
git add plus/packages/realtime/CORE.md tests/gates/test_plus_realtime_core.py
git commit -m "build(realtime): protect the core boundaries"
```

---

## Task 5: API integration — contracts, read model, topic, plugin, inline relay

**Files:**
- Modify: `plus/packages/contracts/src/voting.ts`
- Create: `plus/packages/runtime/src/voting-read-service.ts`
- Create: `plus/packages/runtime/src/relay-loop.ts`
- Modify: `plus/packages/runtime/src/index.ts`
- Modify: `plus/apps/worker/src/main.ts`
- Delete: `plus/apps/worker/src/relay-loop.ts`
- Modify: `plus/apps/worker/test/relay-loop.test.ts` (import path)
- Create: `plus/apps/api/src/realtime-topics.ts`
- Modify: `plus/apps/api/src/app.ts`
- Modify: `plus/apps/api/src/main.ts`
- Create: `plus/apps/api/test/realtime-voting.test.ts`

- [ ] **Step 1: Add the shared snapshot schema**

In `plus/packages/contracts/src/voting.ts` append:

```ts
export const VotingCandidateSnapshotSchema = Type.Object(
  {
    optionId: Type.String({ minLength: 1, maxLength: 100 }),
    candidateId: Type.String({ minLength: 1, maxLength: 100 }),
    ordinal: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const VotingSessionSnapshotSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 100 }),
    status: Type.Union([Type.Literal("open"), Type.Literal("closed")]),
    mode: Type.String({ minLength: 1, maxLength: 20 }),
    revision: Type.Integer({ minimum: 0 }),
    candidateCount: Type.Integer({ minimum: 0 }),
    candidates: Type.Array(VotingCandidateSnapshotSchema),
    live: Type.Union([
      Type.Null(),
      Type.Object(
        {
          seq: Type.Integer({ minimum: 0 }),
          counts: Type.Record(Type.String(), Type.Integer({ minimum: 0 })),
          lastEventType: Type.String({ minLength: 1, maxLength: 100 }),
        },
        { additionalProperties: false },
      ),
    ]),
  },
  { additionalProperties: false },
);

export const VotingSessionsSnapshotSchema = Type.Object(
  {
    activityId: Type.String({ minLength: 1, maxLength: 100 }),
    sessions: Type.Array(VotingSessionSnapshotSchema),
  },
  { additionalProperties: false },
);

export type VotingSessionsSnapshot = Static<typeof VotingSessionsSnapshotSchema>;
```

- [ ] **Step 2: Add the runtime read model**

`plus/packages/runtime/src/voting-read-service.ts`:

```ts
import type { Database } from "@artflow-plus/db";
import {
  getActivity,
  getLiveState,
  listVoteOptions,
  listVoteSessionsForActivity,
} from "@artflow-plus/db";
import type { Kysely } from "kysely";

import type { VotingLiveState } from "./live-projection.js";

export interface VotingSessionsState {
  readonly activityId: string;
  readonly sessions: readonly {
    readonly id: string;
    readonly status: "open" | "closed";
    readonly mode: string;
    readonly revision: number;
    readonly candidateCount: number;
    readonly candidates: readonly {
      readonly optionId: string;
      readonly candidateId: string;
      readonly ordinal: number;
    }[];
    readonly live: {
      readonly seq: number;
      readonly counts: Readonly<Record<string, number>>;
      readonly lastEventType: string;
    } | null;
  }[];
}

/** Permission checks belong to the route/topic caller; this reads the projection. */
export async function readVotingSessionsState(
  db: Kysely<Database>,
  activityId: string,
): Promise<VotingSessionsState | null> {
  const activity = await getActivity(db, activityId);
  if (activity === null) return null;
  const sessions = await listVoteSessionsForActivity(db, activityId);
  const result: VotingSessionsState["sessions"] = [];
  for (const session of sessions) {
    const options = await listVoteOptions(db, session.id);
    const live = await getLiveState(db, activityId, "vote_session", session.id);
    const state = live?.state as VotingLiveState | null | undefined;
    result.push({
      id: session.id,
      status: session.status === "closed" ? "closed" : "open",
      mode: session.mode,
      revision: session.revision,
      candidateCount: options.length,
      candidates: options.map((option) => ({
        optionId: option.id,
        candidateId: option.candidateId,
        ordinal: option.ordinal,
      })),
      live:
        live === null || state === null || state === undefined
          ? null
          : {
              seq: live.lastSequence,
              counts: state.counts,
              lastEventType: state.lastEventType,
            },
    });
  }
  return { activityId, sessions: result };
}
```

Export it from `packages/runtime/src/index.ts`.

- [ ] **Step 3: Move the relay loop into runtime**

Create `plus/packages/runtime/src/relay-loop.ts` with the exact implementation currently in `apps/worker/src/relay-loop.ts` (move the file), export it from `packages/runtime/src/index.ts`, change `apps/worker/src/main.ts` to import `startRelayLoop` from `@artflow-plus/runtime`, delete `apps/worker/src/relay-loop.ts`, and change `apps/worker/test/relay-loop.test.ts` to import from `@artflow-plus/runtime`.

- [ ] **Step 4: Register the voting topic**

`plus/apps/api/src/realtime-topics.ts`:

```ts
import { VotingSessionsSnapshotSchema } from "@artflow-plus/contracts";
import type { Database } from "@artflow-plus/db";
import {
  parseTopicString,
  type RealtimeActor,
  type RealtimeTopic,
} from "@artflow-plus/realtime/protocol";
import { readVotingSessionsState } from "@artflow-plus/runtime";
import type { Kysely } from "kysely";

function can(actor: RealtimeActor, permission: string): boolean {
  return actor.permissions.includes("*") || actor.permissions.includes(permission);
}

export function createVotingRealtimeTopic(db: Kysely<Database>): RealtimeTopic {
  return {
    namespace: "voting",
    parse(topic) {
      const parsed = parseTopicString(topic);
      if (parsed === null || parsed.namespace !== "voting") return null;
      return { activityId: parsed.rest, aggregateId: parsed.rest };
    },
    async authorize(actor, target) {
      return target.activityId.length > 0 && can(actor, "voting.manage");
    },
    async snapshot(target) {
      const data = await readVotingSessionsState(db, target.activityId);
      if (data === null) return null;
      const seq = Math.max(0, ...data.sessions.map((session) => session.live?.seq ?? 0));
      return { seq, data };
    },
    schema: VotingSessionsSnapshotSchema,
  };
}
```

- [ ] **Step 5: Add the REST list route and publishing stages**

In `plus/apps/api/src/app.ts` after the existing POST `/voting/sessions` route:

```ts
  app.get(
    "/api/activities/:id/voting/sessions",
    { schema: { params: ActivityParams } },
    async (request) => {
      const { id } = request.params as { id: string };
      const context = await requestDeps(request);
      requirePermission(context.actor ?? SYSTEM_ACTOR, "voting.manage");
      const state = await readVotingSessionsState(db, id);
      if (state === null) throw new DomainError("NOT_FOUND", `Activity ${id} was not found.`);
      return state;
    },
  );
```

Import `readVotingSessionsState` from `@artflow-plus/runtime`.

In `plus/packages/runtime/src/publishing-service.ts`, extend `PublishingState`:

```ts
export interface PublishingState {
  readonly stageResults: readonly StoredStageResult[];
  readonly publications: readonly StoredResultPublication[];
  readonly releases: readonly StoredResultRelease[];
  readonly stages: readonly PublishingStageDefinition[];
}
```

In `getPublishingState`, replace the activity select with `getActivity` and load the release artifact:

```ts
  requirePermission(runtimeActor(deps), "result.manage");
  const activity = await getActivity(db, input.activityId);
  if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
  let stages: readonly PublishingStageDefinition[] = [];
  if (activity.activeDefinitionVersion > 0) {
    const release = await getRelease(db, activity.id, activity.activeDefinitionVersion);
    const plan = release?.capabilities.publishing;
    if (plan !== undefined && plan.ok === true) {
      stages = decodePublishingArtifact(plan.artifact).stages;
    }
  }
  // ...existing three reads...
  return { stageResults, publications, releases, stages };
```

- [ ] **Step 6: Register the WebSocket server in `buildApp`**

In `plus/apps/api/src/app.ts`:

```ts
import { createRealtimeServer } from "@artflow-plus/realtime/server";
import { createVotingRealtimeTopic } from "./realtime-topics.js";
```

At the end of `buildApp`, after the last route and before `return app`:

```ts
  const realtime = await createRealtimeServer({
    fastify: app,
    authenticate: async (request) => {
      try {
        return await requestActor(request);
      } catch {
        return null;
      }
    },
    topics: [createVotingRealtimeTopic(db)],
  });
  app.addHook("onClose", async () => {
    await realtime.close();
  });
```

- [ ] **Step 7: Add the inline relay flag to the API**

In `plus/apps/api/src/main.ts`:

```ts
import { closeDb, createDb, migrate } from "@artflow-plus/db";
import { relayOutboxOnce, startRelayLoop } from "@artflow-plus/runtime";
```

After `buildApp`:

```ts
  const inlineRelay = process.env.ARTFLOW_PLUS_INLINE_RELAY === "1"
    ? startRelayLoop(() => relayOutboxOnce(db), {
        intervalMs: 250,
        onError: (error) => console.error("inline outbox relay:", error),
      })
    : null;
```

In `shutdown`, call `inlineRelay?.()` before `app.close()`.

- [ ] **Step 8: Write the failing API/realtime test**

`plus/apps/api/test/realtime-voting.test.ts`:

```ts
import { randomUUID } from "node:crypto";

import {
  closeDb,
  createDb,
  insertLocalAccount,
  insertRelease,
  migrate,
} from "@artflow-plus/db";
import type { Database } from "@artflow-plus/db";
import { hashPassword } from "@artflow-plus/runtime";
import type { RuntimeDeps } from "@artflow-plus/runtime";
import type { FastifyInstance } from "fastify";
import { Client } from "pg";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { createVotingRealtimeTopic } from "../src/realtime-topics.js";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && connectionString === undefined) {
  throw new Error("REQUIRE_DB=1 but ARTFLOW_PLUS_DATABASE_URL is unset.");
}
const schema = `artflow_api_realtime_${Date.now()}_${process.pid}`;

let app: FastifyInstance;
let db: Kysely<Database>;
let admin: Client;
let opsToken = "";
let participantToken = "";

const deps: RuntimeDeps = {
  now: () => new Date().toISOString(),
  newEventId: () => randomUUID(),
};

async function seed() {
  const activityId = `act-${randomUUID()}`;
  const sessionId = `vote-${randomUUID()}`;
  await db.insertInto("activity").values({
    id: activityId,
    public_code: activityId,
    title: "投票",
    status: "active",
    revision: 1,
    enabled_capabilities: JSON.stringify(["voting", "publishing"]),
    active_definition_version: 1,
  }).execute();
  await insertRelease(db, {
    activityId,
    version: 1,
    contentHash: "realtime-release",
    capabilities: {
      publishing: {
        ok: true,
        capabilityKey: "publishing",
        contentHash: "realtime-publishing",
        artifact: {
          version: 1,
          schemaVersion: 1,
          stages: [{ key: "vote_result", label: "投票结果" }],
        },
      },
    },
    executionPolicy: { declaredScopes: ["publishing"], conflicts: {}, runtimeContractVersion: 1 },
    capabilityVersions: { publishing: "1" },
    bindings: [],
    releasedAt: "2026-10-27T09:00:00Z",
    sourceDraftRevision: 1,
  });
  await db.insertInto("vote_session").values({
    id: sessionId,
    activity_id: activityId,
    definition_version: 1,
    mode: "formal",
    purpose: "popularity",
    selection_type: "single",
    max_selections: 1,
    identity_policy: "browser",
    scoring_rule: JSON.stringify({ kind: "ballot_share_percent", scale: 100, decimals: 2 }),
    status: "open",
    revision: 0,
    opened_at: "2026-10-27T09:00:00Z",
    closed_at: null,
  }).execute();
  await db.insertInto("vote_option").values({
    id: `${sessionId}-option-0`,
    activity_id: activityId,
    session_id: sessionId,
    candidate_id: "alice",
    ordinal: 0,
  }).execute();
  await db.insertInto("live_state").values({
    activity_id: activityId,
    aggregate_type: "vote_session",
    aggregate_id: sessionId,
    last_sequence: 5,
    state: JSON.stringify({
      activityId,
      sessionId,
      status: "open",
      optionIds: [`${sessionId}-option-0`],
      counts: { [`${sessionId}-option-0`]: 3 },
      authoritative: false,
      lastEventType: "BallotSubmitted",
    }),
    status: "running",
  }).execute();
  return { activityId, sessionId };
}

async function login(username: string, password: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { "content-type": "application/json" },
    payload: { username, password },
  });
  expect(response.statusCode).toBe(200);
  return response.json().token as string;
}

describe.skipIf(!connectionString)("realtime voting integration", () => {
  beforeAll(async () => {
    if (!connectionString) return;
    admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = createDb({ connectionString, schema });
    await migrate(db);
    app = await buildApp({ db, deps, enableRuntimeFacts: true });
    await app.ready();
    await insertLocalAccount(db, {
      username: "realtime-ops",
      passwordDigest: hashPassword("realtime-password"),
      actor: {
        actorId: "realtime-ops",
        actorType: "user",
        roles: ["staff"],
        permissions: ["voting.manage", "result.manage"],
      },
      active: true,
    });
    await insertLocalAccount(db, {
      username: "realtime-participant",
      passwordDigest: hashPassword("participant-password"),
      actor: { actorId: "realtime-participant", actorType: "user", roles: [], permissions: [] },
      active: true,
    });
    opsToken = await login("realtime-ops", "realtime-password");
    participantToken = await login("realtime-participant", "participant-password");
  });

  afterAll(async () => {
    if (!connectionString) return;
    await app.close();
    await closeDb(db);
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("returns the voting snapshot over REST", async () => {
    const { activityId, sessionId } = await seed();
    const response = await app.inject({
      method: "GET",
      url: `/api/activities/${activityId}/voting/sessions`,
      headers: { authorization: `Bearer ${opsToken}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      sessions: { id: string; live: { seq: number; counts: Record<string, number> } | null }[];
    };
    expect(body.sessions[0]).toMatchObject({
      id: sessionId,
      live: { seq: 5, counts: { [`${sessionId}-option-0`]: 3 } },
    });
  });

  it("authorizes the voting topic and builds a monotonic snapshot", async () => {
    const { activityId } = await seed();
    const topic = createVotingRealtimeTopic(db);
    const target = topic.parse(`voting:${activityId}`);
    expect(target).toEqual({ activityId, aggregateId: activityId });
    expect(await topic.authorize({ actorId: "x", roles: [], permissions: [] }, { topic: `voting:${activityId}`, ...target! })).toBe(false);
    expect(await topic.authorize({ actorId: "x", roles: [], permissions: ["voting.manage"] }, { topic: `voting:${activityId}`, ...target! })).toBe(true);
    const snapshot = await topic.snapshot({ topic: `voting:${activityId}`, ...target! });
    expect(snapshot?.seq).toBeGreaterThanOrEqual(5);
    expect(snapshot?.data).toMatchObject({ activityId });
  });

  it("returns the declared publishing stages in the state read", async () => {
    const { activityId } = await seed();
    const response = await app.inject({
      method: "GET",
      url: `/api/activities/${activityId}/publishing/state`,
      headers: { authorization: `Bearer ${opsToken}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ stages: [{ key: "vote_result", label: "投票结果" }] });
  });

  it("rejects a non-voting caller on the session list", async () => {
    const { activityId } = await seed();
    const response = await app.inject({
      method: "GET",
      url: `/api/activities/${activityId}/voting/sessions`,
      headers: { authorization: `Bearer ${participantToken}` },
    });
    expect(response.statusCode).toBe(403);
  });
});
```

- [ ] **Step 9: Run it and confirm it fails, then implement**

```powershell
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
$env:REQUIRE_DB = "1"
Set-Location "C:\Users\16275\Desktop\ArtFlow\plus\apps\api"
pnpm exec vitest run test/realtime-voting.test.ts
```

Expected first run: FAIL (missing route/topic). After Steps 1-7 it passes (4 tests).

- [ ] **Step 10: Run the API suite and commit**

```powershell
pnpm check
pnpm exec vitest run
```
Commit:

```powershell
git add plus/packages/contracts/src/voting.ts plus/packages/runtime/src plus/apps/api/src plus/apps/api/test/realtime-voting.test.ts plus/apps/worker
git commit -m "feat(api): register the voting realtime topic"
```

---

## Task 6: Web client, hook, card, and E2E

**Files:**
- Create: `plus/apps/web/src/realtime/client.ts`
- Create: `plus/apps/web/src/realtime/useRealtimeTopic.ts`
- Create: `plus/apps/web/src/api/voting.ts`
- Create: `plus/apps/web/src/components/ops/VotingCard.tsx`
- Modify: `plus/apps/web/src/routes/opsActivity.tsx`
- Modify: `plus/apps/api/scripts/seed-registration.ts` (permissions)
- Create: `plus/apps/api/scripts/seed-voting.ts`
- Modify: `plus/apps/api/package.json` (`seed:e2e`)
- Create: `plus/apps/web/e2e/voting.spec.ts`
- Modify: `plus/apps/web/playwright.config.ts` (inline relay env)
- Modify: `plus/apps/web/vite.config.ts` (proxy `ws: true`)
- Modify: `plus/apps/web/src/styles/global.css` (card layout)

- [ ] **Step 1: Build the realtime client singleton and hook**

`plus/apps/web/src/realtime/client.ts`:

```ts
import { createRealtimeClient } from "@artflow-plus/realtime/client";
import type { RealtimeClient } from "@artflow-plus/realtime/client";

let client: RealtimeClient | null = null;

export function getRealtimeClient(): RealtimeClient {
  client ??= createRealtimeClient({ url: "/api/realtime" });
  return client;
}
```

`plus/apps/web/src/realtime/useRealtimeTopic.ts`:

```ts
import { useEffect, useRef, useState } from "react";

import { getRealtimeClient } from "./client.js";

export function useRealtimeTopic<T>(
  topic: string | null,
  onData: (data: T, seq: number) => void,
): { readonly fallback: boolean } {
  const [fallback, setFallback] = useState(false);
  const onDataRef = useRef(onData);
  onDataRef.current = onData;

  useEffect(() => {
    const client = getRealtimeClient();
    const offFallback = client.onFallbackChange(setFallback);
    if (topic === null) return offFallback;
    const unsubscribe = client.subscribe<T>(topic, {
      onSnapshot: (data, seq) => onDataRef.current(data, seq),
      onUpdate: (data, seq) => onDataRef.current(data, seq),
    });
    return () => {
      unsubscribe();
      offFallback();
    };
  }, [topic]);

  return { fallback };
}
```

- [ ] **Step 2: Add the web API client**

`plus/apps/web/src/api/voting.ts`:

```ts
import { apiFetch } from "./client.js";
import type { VotingSessionsSnapshot } from "@artflow-plus/contracts";

export interface ExecutionSessionView {
  readonly id: string;
  readonly activityId: string;
  readonly definitionVersion: number;
  readonly scope: string;
  readonly mode: "test" | "rehearsal" | "formal";
  readonly status: "running" | "closed";
  readonly revision: number;
}

export interface PublishingStateView {
  readonly stages: readonly { readonly key: string; readonly label: string }[];
}

export interface VoteResultCandidateView {
  readonly sessionId: string;
  readonly sessionRevision: number;
  readonly mode: string;
  readonly totalBallots: number;
  readonly status: "ready" | "hold";
  readonly holdReason?: "NO_VALID_BALLOTS";
  readonly inputFingerprint: string;
  readonly decisions: readonly {
    readonly rank: number;
    readonly contestantId: string;
    readonly score: string;
    readonly count: number;
    readonly unit: "percent";
  }[];
}

function commandId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export async function fetchVotingSessions(activityId: string): Promise<VotingSessionsSnapshot> {
  return apiFetch<VotingSessionsSnapshot>(`/api/activities/${activityId}/voting/sessions`);
}

export async function fetchExecutions(activityId: string): Promise<readonly ExecutionSessionView[]> {
  const response = await apiFetch<{ sessions: readonly ExecutionSessionView[] }>(
    `/api/activities/${activityId}/executions`,
  );
  return response.sessions;
}

export async function startExecution(
  activityId: string,
  scope: string,
): Promise<ExecutionSessionView> {
  return apiFetch<ExecutionSessionView>(`/api/activities/${activityId}/executions`, {
    method: "POST",
    headers: { "idempotency-key": commandId("execution-start") },
    body: JSON.stringify({ scope, mode: "formal" }),
  });
}

export async function closeExecution(
  activityId: string,
  sessionId: string,
  expectedRevision: number,
): Promise<ExecutionSessionView> {
  return apiFetch<ExecutionSessionView>(
    `/api/activities/${activityId}/executions/${sessionId}/close`,
    {
      method: "POST",
      headers: { "idempotency-key": commandId("execution-close") },
      body: JSON.stringify({ expectedRevision }),
    },
  );
}

export async function openVoteSession(
  activityId: string,
  candidateIds: readonly string[],
): Promise<unknown> {
  return apiFetch(`/api/activities/${activityId}/voting/sessions`, {
    method: "POST",
    headers: { "idempotency-key": commandId("vote-open") },
    body: JSON.stringify({
      sessionId: `vote-${crypto.randomUUID()}`,
      scope: "voting",
      candidateIds,
    }),
  });
}

export async function closeVoteSession(
  activityId: string,
  sessionId: string,
  expectedRevision: number,
): Promise<unknown> {
  return apiFetch(`/api/activities/${activityId}/voting/sessions/${sessionId}/close`, {
    method: "POST",
    headers: { "idempotency-key": commandId("vote-close") },
    body: JSON.stringify({ scope: "voting", expectedRevision }),
  });
}

export async function fetchPublishingState(activityId: string): Promise<PublishingStateView> {
  return apiFetch<PublishingStateView>(`/api/activities/${activityId}/publishing/state`);
}

export async function previewVoteResult(
  activityId: string,
  sessionId: string,
): Promise<VoteResultCandidateView> {
  return apiFetch<VoteResultCandidateView>(
    `/api/activities/${activityId}/publishing/vote-results/${sessionId}`,
  );
}

export async function confirmVoteResult(
  activityId: string,
  stageKey: string,
  candidate: VoteResultCandidateView,
): Promise<{ readonly candidateRevision: number }> {
  return apiFetch(`/api/activities/${activityId}/publishing/stage-results/${stageKey}/confirm-vote`, {
    method: "POST",
    headers: { "idempotency-key": commandId("vote-confirm") },
    body: JSON.stringify({
      scope: "publishing",
      voteSessionId: candidate.sessionId,
      expectedSessionRevision: candidate.sessionRevision,
      expectedInputFingerprint: candidate.inputFingerprint,
      awards: [],
    }),
  });
}

export async function releaseVoteResult(
  activityId: string,
  stageKey: string,
  expectedCandidateRevision: number,
  note: string,
): Promise<unknown> {
  return apiFetch(`/api/activities/${activityId}/publishing/releases`, {
    method: "POST",
    headers: { "idempotency-key": commandId("vote-release") },
    body: JSON.stringify({ stageKey, scope: "publishing", expectedCandidateRevision, note }),
  });
}
```

- [ ] **Step 3: Build the card**

`plus/apps/web/src/components/ops/VotingCard.tsx`:

```tsx
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { ApiError } from "../../api/client.js";
import {
  closeExecution,
  closeVoteSession,
  confirmVoteResult,
  fetchExecutions,
  fetchPublishingState,
  fetchVotingSessions,
  openVoteSession,
  previewVoteResult,
  releaseVoteResult,
  startExecution,
} from "../../api/voting.js";
import type { VoteResultCandidateView } from "../../api/voting.js";
import type { VotingSessionsSnapshot } from "@artflow-plus/contracts";
import { useRealtimeTopic } from "../../realtime/useRealtimeTopic.js";

function humanError(error: unknown): string {
  const code = error instanceof ApiError ? error.code : "";
  if (code === "VOTE_SESSION_NOT_OPEN") return "投票场次还没有关闭。";
  if (code === "STALE_RESOLUTION_INPUT") return "票数在预览后变化了，请重新预览。";
  if (code === "NO_VALID_BALLOTS") return "没有有效票，不能发布。";
  if (code === "RESULT_NOT_CONFIRMED") return "先确认赛果再发布。";
  if (code === "SESSION_NOT_RUNNING") return "对应的执行会话还没有启动。";
  return error instanceof Error ? error.message : String(error);
}

export function VotingCard(props: {
  readonly activityId: string;
  readonly canManageVotes: boolean;
  readonly canManageResults: boolean;
  readonly canManageSessions: boolean;
}) {
  const queryClient = useQueryClient();
  const [candidateText, setCandidateText] = useState("");
  const [preview, setPreview] = useState<VoteResultCandidateView | null>(null);
  const [stageKey, setStageKey] = useState("vote_result");
  const [note, setNote] = useState("");

  const onRealtimeData = (data: VotingSessionsSnapshot): void => {
    queryClient.setQueryData(["voting-sessions", props.activityId], data);
  };
  const { fallback } = useRealtimeTopic<VotingSessionsSnapshot>(
    props.canManageVotes ? `voting:${props.activityId}` : null,
    onRealtimeData,
  );
  const sessionsQuery = useQuery({
    queryKey: ["voting-sessions", props.activityId],
    queryFn: () => fetchVotingSessions(props.activityId),
    retry: false,
    refetchInterval: fallback ? 5000 : false,
  });
  const executionsQuery = useQuery({
    queryKey: ["executions", props.activityId],
    queryFn: () => fetchExecutions(props.activityId),
    retry: false,
  });
  const publishingQuery = useQuery({
    queryKey: ["publishing-state", props.activityId],
    queryFn: () => fetchPublishingState(props.activityId),
    retry: false,
    enabled: props.canManageResults,
  });
  const sessions = sessionsQuery.data?.sessions ?? [];
  const executions = executionsQuery.data ?? [];
  const stages = publishingQuery.data?.stages ?? [];
  const effectiveStage = stages.some((stage) => stage.key === stageKey)
    ? stageKey
    : stages[0]?.key ?? "vote_result";

  const running = (scope: string) =>
    executions.find((session) => session.scope === scope && session.status === "running");

  const start = useMutation({
    mutationFn: (scope: string) => startExecution(props.activityId, scope),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["executions", props.activityId] });
    },
  });
  const closeExecutionMutation = useMutation({
    mutationFn: (session: { readonly id: string; readonly revision: number }) =>
      closeExecution(props.activityId, session.id, session.revision),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["executions", props.activityId] });
    },
  });
  const open = useMutation({
    mutationFn: () =>
      openVoteSession(
        props.activityId,
        candidateText
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean),
      ),
    onSuccess: () => {
      setCandidateText("");
      void queryClient.invalidateQueries({ queryKey: ["voting-sessions", props.activityId] });
    },
  });
  const closeSession = useMutation({
    mutationFn: (session: { readonly id: string; readonly revision: number }) =>
      closeVoteSession(props.activityId, session.id, session.revision),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["voting-sessions", props.activityId] });
    },
  });
  const loadPreview = useMutation({
    mutationFn: (sessionId: string) => previewVoteResult(props.activityId, sessionId),
    onSuccess: (candidate) => setPreview(candidate),
  });
  const confirm = useMutation({
    mutationFn: (candidate: VoteResultCandidateView) =>
      confirmVoteResult(props.activityId, effectiveStage, candidate),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["publishing-state", props.activityId] });
    },
  });
  const release = useMutation({
    mutationFn: (candidateRevision: number) =>
      releaseVoteResult(props.activityId, effectiveStage, candidateRevision, note),
    onSuccess: () => {
      setNote("");
      void queryClient.invalidateQueries({ queryKey: ["publishing-state", props.activityId] });
    },
  });

  const error =
    sessionsQuery.error ??
    executionsQuery.error ??
    start.error ??
    closeExecutionMutation.error ??
    open.error ??
    closeSession.error ??
    loadPreview.error ??
    confirm.error ??
    release.error;

  if (!props.canManageVotes) return null;
  if (sessionsQuery.isLoading) return <section className="ops-card">正在读取投票…</section>;

  const voteSession = running("voting");
  const publishingSession = running("publishing");

  return (
    <section className="ops-card voting-card">
      <p className="eyebrow">VOTING · 投票</p>
      <h2>投票与发布</h2>

      <div className="voting-sessions">
        {(["voting", "publishing"] as const).map((scope) => {
          const session = running(scope);
          return (
            <div key={scope} className="voting-session-row">
              <span>{scope} 会话</span>
              <span>{session === undefined ? "未启动" : "运行中"}</span>
              {props.canManageSessions ? (
                session === undefined ? (
                  <button type="button" onClick={() => start.mutate(scope)}>启动</button>
                ) : (
                  <button type="button" onClick={() => closeExecutionMutation.mutate(session)}>
                    关闭会话
                  </button>
                )
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="voting-new">
        <label>
          候选（每行一个）
          <textarea
            value={candidateText}
            onChange={(event) => setCandidateText(event.target.value)}
            rows={4}
          />
        </label>
        <button
          type="button"
          disabled={voteSession === undefined || open.isPending || candidateText.trim() === ""}
          onClick={() => open.mutate()}
        >
          开启投票
        </button>
        {voteSession === undefined ? (
          <p className="state-copy">先启动 voting 会话。</p>
        ) : null}
      </div>

      <ul className="voting-list">
        {sessions.map((session) => (
          <li key={session.id} className="voting-session">
            <div>
              <strong>{session.id}</strong>
              <span className="state-copy">
                {session.status === "open" ? "进行中" : "已关闭"} · {session.candidateCount} 个候选
                {fallback && session.live !== null ? " · 轮询中" : ""}
              </span>
            </div>
            {session.status === "open" ? (
              <ul className="voting-candidates">
                {session.candidates.map((candidate) => (
                  <li key={candidate.optionId}>
                    {candidate.candidateId} · {session.live?.counts[candidate.optionId] ?? 0} 票
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="voting-actions">
              {session.status === "open" ? (
                <button type="button" onClick={() => closeSession.mutate(session)}>
                  关闭场次
                </button>
              ) : (
                <button type="button" onClick={() => loadPreview.mutate(session.id)}>
                  预览结果
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>

      {preview === null ? null : (
        <div className="voting-preview">
          <h3>结果预览</h3>
          <table>
            <thead>
              <tr><th>名次</th><th>候选</th><th>票数</th><th>占比</th></tr>
            </thead>
            <tbody>
              {preview.decisions.map((decision) => (
                <tr key={decision.contestantId}>
                  <td>{decision.rank}</td>
                  <td>{decision.contestantId}</td>
                  <td>{decision.count}</td>
                  <td>{decision.score}%</td>
                </tr>
              ))}
            </tbody>
          </table>
          {preview.status === "hold" ? (
            <p className="state-copy">没有有效票，无法发布。</p>
          ) : null}
          {props.canManageResults ? (
            <div className="voting-publish">
              <label>
                阶段
                <select value={effectiveStage} onChange={(event) => setStageKey(event.target.value)}>
                  {stages.map((stage) => (
                    <option key={stage.key} value={stage.key}>{stage.label}</option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                disabled={confirm.isPending || publishingSession === undefined || preview.status === "hold"}
                onClick={() => confirm.mutate(preview)}
              >
                确认赛果
              </button>
              <label>
                发布备注
                <input value={note} onChange={(event) => setNote(event.target.value)} />
              </label>
              <button
                type="button"
                disabled={release.isPending || note.trim() === "" || confirm.data === undefined}
                onClick={() =>
                  confirm.data === undefined ? undefined : release.mutate(confirm.data.candidateRevision)
                }
              >
                发布结果
              </button>
              {publishingSession === undefined ? (
                <p className="state-copy">先启动 publishing 会话。</p>
              ) : null}
            </div>
          ) : null}
        </div>
      )}

      {error === null || error === undefined ? null : (
        <p className="form-error" role="alert">{humanError(error)}</p>
      )}
    </section>
  );
}
```

Notes for the implementer:

- `confirm` must return the stage result body (`candidateRevision`); type the `apiFetch` accordingly.
- `release` requires a confirmed stage result; the button is enabled only after a successful confirm.
- `publishingQuery` is enabled only with `result.manage`; the WS topic only needs `voting.manage`.

- [ ] **Step 4: Render the card**

In `plus/apps/web/src/routes/opsActivity.tsx`:

```tsx
import { VotingCard } from "../components/ops/VotingCard.js";
```

```tsx
        {activity?.enabledCapabilities.includes("voting") ? (
          <VotingCard
            key={activityId}
            activityId={activityId}
            canManageVotes={can(session?.actor.permissions, "voting.manage")}
            canManageResults={can(session?.actor.permissions, "result.manage")}
            canManageSessions={
              can(session?.actor.permissions, "studio.manage") ||
              can(session?.actor.permissions, "competition.manage")
            }
          />
        ) : null}
```

Add this module-level helper in `opsActivity.tsx`:

```tsx
function can(permissions: readonly string[] | undefined, permission: string): boolean {
  if (permissions === undefined) return false;
  return permissions.includes("*") || permissions.includes(permission);
}
```

- [ ] **Step 4b: Add minimal card styles**

Append to `plus/apps/web/src/styles/global.css`:

```css
.voting-card { display: grid; gap: 12px; }
.voting-session-row { display: flex; gap: 12px; align-items: center; }
.voting-list { list-style: none; padding: 0; display: grid; gap: 12px; }
.voting-session { border: 1px solid var(--line, #ddd); border-radius: 10px; padding: 12px; }
.voting-candidates { margin: 8px 0; padding-left: 18px; }
.voting-preview table { width: 100%; border-collapse: collapse; }
.voting-preview th,
.voting-preview td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--line, #ddd); }
.voting-publish { display: grid; gap: 8px; margin-top: 12px; }
```

- [ ] **Step 5: Seed the E2E activity and permissions**

In `plus/apps/api/scripts/seed-registration.ts`, add to `adminPermissions`:

```ts
  "voting.manage",
  "result.manage",
```

Create `plus/apps/api/scripts/seed-voting.ts` modeled on `seed-grouping.ts`:

`plus/apps/api/scripts/seed-voting.ts`:

```ts
import {
  closeDb,
  createDb,
  getActivity,
  insertRelease,
  migrate,
} from "@artflow-plus/db";
import { Client } from "pg";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (connectionString === undefined || connectionString.trim() === "") {
  throw new Error("ARTFLOW_PLUS_DATABASE_URL is required.");
}
const schema = process.env.ARTFLOW_PLUS_DB_SCHEMA;
if (schema !== undefined && !/^[a-z_][a-z0-9_]*$/.test(schema)) {
  throw new Error(`Unsafe ARTFLOW_PLUS_DB_SCHEMA: ${schema}`);
}
if (schema !== undefined) {
  const admin = new Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  await admin.end();
}

const db = createDb({ connectionString, ...(schema === undefined ? {} : { schema }) });
await migrate(db);

const activityId = "act_e2e_voting";
const publicCode = "E2E-VOTING";

// Reset only what this seed owns; the activity and its release are reused.
await db.deleteFrom("result_release").where("activity_id", "=", activityId).execute();
await db.deleteFrom("result_publication").where("activity_id", "=", activityId).execute();
await db.deleteFrom("stage_result").where("activity_id", "=", activityId).execute();
await db.deleteFrom("live_state").where("activity_id", "=", activityId).execute();
// A stale dead letter blocks the (activity, mode) projection partition forever.
await db.deleteFrom("outbox").where("activity_id", "=", activityId).execute();
await db.deleteFrom("execution_projection").where("activity_id", "=", activityId).execute();
await db.deleteFrom("vote_record").where("activity_id", "=", activityId).execute();
await db.deleteFrom("ballot").where("activity_id", "=", activityId).execute();
await db.deleteFrom("vote_option").where("activity_id", "=", activityId).execute();
await db.deleteFrom("vote_session").where("activity_id", "=", activityId).execute();
await db.deleteFrom("execution_session").where("activity_id", "=", activityId).execute();

if ((await getActivity(db, activityId)) === null) {
  await db.insertInto("activity").values({
    id: activityId,
    public_code: publicCode,
    title: "E2E 投票",
    status: "active",
    revision: 1,
    enabled_capabilities: JSON.stringify(["voting", "publishing"]),
    active_definition_version: 1,
  }).execute();

  await insertRelease(db, {
    activityId,
    version: 1,
    contentHash: "e2e-voting-release",
    capabilities: {
      voting: {
        ok: true,
        capabilityKey: "voting",
        contentHash: "e2e-voting",
        artifact: {
          version: 2,
          schemaVersion: 2,
          purpose: "popularity",
          selectionType: "single",
          maxSelections: 1,
          identityPolicy: "browser",
          scoringRule: { kind: "ballot_share_percent", scale: 100, decimals: 2 },
        },
      },
      publishing: {
        ok: true,
        capabilityKey: "publishing",
        contentHash: "e2e-voting-publishing",
        artifact: {
          version: 1,
          schemaVersion: 1,
          stages: [{ key: "vote_result", label: "投票结果" }],
        },
      },
    },
    executionPolicy: {
      declaredScopes: ["voting", "publishing"],
      conflicts: {},
      runtimeContractVersion: 1,
    },
    capabilityVersions: { voting: "1", publishing: "1" },
    bindings: [],
    releasedAt: "2026-10-27T09:00:00Z",
    sourceDraftRevision: 1,
  });
}

await closeDb(db);
console.log(`Seeded voting activity ${activityId} (${publicCode}).`);
```

Add `tsx scripts/seed-voting.ts` to `seed:e2e`.

In `plus/apps/web/playwright.config.ts`, add to the API webServer env:

```ts
        ARTFLOW_PLUS_INLINE_RELAY: "1",
```

In `plus/apps/web/vite.config.ts`, enable WebSocket proxying:

```ts
const proxy = {
  "/api": { target: apiTarget, changeOrigin: true, ws: true },
};
```

- [ ] **Step 6: Write the E2E**

`plus/apps/web/e2e/voting.spec.ts`:

```ts
import { expect, request as apiRequest, test } from "@playwright/test";

test("ops runs a vote and publishes the live result", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("用户名").fill("e2e-ops");
  await page.getByLabel("密码").fill("e2e-ops-password");
  await page.getByRole("button", { name: "登录" }).click();
  await page.waitForURL(/\/ops$/);

  await page.goto("/ops/act_e2e_voting");
  await expect(page.getByRole("heading", { name: "投票与发布" })).toBeVisible();

  // Start the two execution sessions the card needs.
  const sessionRows = page.locator(".voting-session-row");
  await sessionRows.filter({ hasText: "voting 会话" }).getByRole("button", { name: "启动" }).click();
  await expect(sessionRows.filter({ hasText: "voting 会话" }).getByText("运行中")).toBeVisible();
  await sessionRows.filter({ hasText: "publishing 会话" }).getByRole("button", { name: "启动" }).click();
  await expect(sessionRows.filter({ hasText: "publishing 会话" }).getByText("运行中")).toBeVisible();

  // Open a vote with two candidates.
  await page.getByLabel("候选（每行一个）").fill("alice\nbob");
  await page.getByRole("button", { name: "开启投票" }).click();
  await expect(page.getByText(/alice · 0 票/)).toBeVisible();

  // Cast a ballot through the public route using the browser identity cookie.
  const activityId = "act_e2e_voting";
  const sessions = await page.request.get(`/api/activities/${activityId}/voting/sessions`);
  const session = (await sessions.json()).sessions[0] as {
    id: string;
    candidates: { optionId: string; candidateId: string }[];
  };
  // A voter is anonymous: a fresh request context has no Ops session cookie,
  // so the write does not require a CSRF token.
  const voter = await apiRequest.newContext({ baseURL: new URL(page.url()).origin });
  await voter.get(`/api/activities/${activityId}/voting/browser-identity`);
  const alice = session.candidates.find((candidate) => candidate.candidateId === "alice");
  if (alice === undefined) throw new Error("alice option missing");
  const ballot = await voter.post(
    `/api/activities/${activityId}/voting/sessions/${session.id}/ballots`,
    {
      headers: { "idempotency-key": `e2e-ballot-${Date.now()}` },
      data: { scope: "voting", optionIds: [alice.optionId], identity: { type: "browser" } },
    },
  );
  expect(ballot.ok(), await ballot.text()).toBe(true);
  await voter.dispose();

  // The card updates over WebSocket without a reload.
  await expect(page.getByText(/alice · 1 票/)).toBeVisible({ timeout: 10_000 });

  await page.getByRole("button", { name: "关闭场次" }).click();
  await page.getByRole("button", { name: "预览结果" }).click();
  await expect(page.getByText("结果预览")).toBeVisible();
  await page.getByRole("button", { name: "确认赛果" }).click();
  await page.getByLabel("发布备注").fill("人气投票结果");
  await page.getByRole("button", { name: "发布结果" }).click();

  const publicRead = await page.request.get("/api/public/results/E2E-VOTING");
  expect(publicRead.ok()).toBe(true);
  const publicBody = await publicRead.json() as {
    results: { decisions: { contestantId: string; unit?: string }[] }[];
  };
  expect(publicBody.results[0]?.decisions[0]).toMatchObject({
    contestantId: "alice",
    unit: "percent",
  });
  expect(publicBody.results[0]?.decisions[1]).toMatchObject({
    contestantId: "bob",
    unit: "percent",
  });
});
```

- [ ] **Step 7: Run the E2E**

```powershell
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
Set-Location "C:\Users\16275\Desktop\ArtFlow\plus\apps\web"
pnpm check
pnpm test:e2e -- e2e/voting.spec.ts
```
Expected: PASS (1 test).

- [ ] **Step 8: Commit**

```powershell
git add plus/apps/web/src/realtime plus/apps/web/src/api/voting.ts plus/apps/web/src/components/ops/VotingCard.tsx plus/apps/web/src/routes/opsActivity.tsx plus/apps/web/src/styles/global.css plus/apps/web/vite.config.ts plus/apps/api/scripts/seed-voting.ts plus/apps/api/scripts/seed-registration.ts plus/apps/api/package.json plus/apps/web/playwright.config.ts plus/apps/web/e2e/voting.spec.ts
git commit -m "feat(web): add the realtime voting card"
```

---

## Task 7: Documentation and full gates

**Files:**
- Create: `docs/architecture/adr/0027-realtime-core.md`
- Create: `docs/invariants/realtime.md`
- Modify: `docs/artflow-plus/roadmap.md`
- Modify: `docs/artflow-plus/shape-validation.md`
- Modify: `deploy/plus/nginx.conf` (WebSocket upgrade headers)

- [ ] **Step 1: Write ADR-0027 and the realtime invariants**

`docs/architecture/adr/0027-realtime-core.md`:

```md
# ADR-0027: One protected realtime core

- **Status**: accepted
- **Date**: 2026-10-27

## Context

v2 only had SSE (`/api/activities/:id/stream`) as an invalidation hint. The voting
card needs live ballot counts with a fallback, and future surfaces will need the
same transport. Ad-hoc sockets per feature would drift.

## Decision

- Add `@artflow-plus/realtime` with `./protocol`, `./server`, `./client`.
- The transport is notification-only: clients subscribe/unsubscribe/ping; all
  mutations stay on HTTP.
- One versioned envelope; handshake authentication and per-topic authorization.
- Updates are full snapshots with a monotonic `seq`; clients drop stale sequences.
  Backpressure drops updates instead of queueing because the next snapshot covers.
- Bounded resources: 32 subscriptions, 4 KiB frames, 1 MiB send buffer, 10
  subscribe requests/second, heartbeat on both ends.
- The server polls each subscribed topic's `snapshot()` (1s default). A future
  LISTEN/NOTIFY source replaces the snapshot provider without changing the
  protocol or client.
- Only this package imports `ws` / `@fastify/websocket`; only `src/client` and the
  package's tests construct `WebSocket`. A structural gate enforces this.

## Consequences

- Feature code registers topics and never forks connection/reconnect logic.
- Permission revocation applies on reconnect, not mid-subscription.
- Multi-instance deployments poll independently; consistent but not coalesced.
- The Live console keeps SSE until a separate migration.
```

`docs/invariants/realtime.md`:

```md
# Realtime invariants

## RT-01 通知-only
Socket 只承载订阅、退订、心跳；状态变更仍走 HTTP 命令并回读权威。

## RT-02 握手鉴权 + 每主题授权
连接建立时解析会话；每次订阅由 topic 的 `authorize` 判定；不信任客户端提交的
activity/权限字段。

## RT-03 快照先行、完整快照、单调 seq
订阅立即下发快照；更新必须是完整快照；客户端丢弃 `seq <= last`。禁止 delta。

## RT-04 有界资源
32 订阅 / 4 KiB 帧 / 1 MiB 发送缓冲 / 10 次订阅请求每秒；背压丢弃更新，不排队。

## RT-05 心跳
服务端 ws ping/pong；客户端应用层 ping/pong；超时关闭并重连。

## RT-06 版本封闭
信封带 `v`；协议变更升版并同时更新两端。

## RT-07 核心独占传输
只有 `packages/realtime` 可 import `ws` / `@fastify/websocket`；只有 `src/client`
与该包测试可构造 `WebSocket`。

## RT-08 核心对业务无知
`packages/realtime` 不 import domain/db/runtime；业务通过 `RealtimeTopic` 接入。

## 变更流程
修改以上任一条，必须先写 ADR 并更新核心契约测试。业务 PR 不得修改
`packages/realtime` 的连接、重连、心跳、信封实现。
```

- [ ] **Step 2: Update roadmap and shape validation**

Roadmap M11:

```md
## M11 — Realtime Core and Voting UI（已完成，2026-10-27）

- 新 `@artflow-plus/realtime`：协议/服务端/客户端、核心门禁与 CORE.md。
- `voting:<activityId>` topic；Ops 投票卡片：会话编排、实时票数、发布投票结果。
- E2E 证明 WebSocket 实时更新与 REST 兜底。
- Live 控制台的 SSE 保持不动，后续单独迁移。
```

In `docs/artflow-plus/shape-validation.md`, replace the row whose last cell mentions
"投票 UI 仍待后续 slice" with:

```md
| 投票场次管理 UI | v2 没有投票界面 | 已由 M11 的 Ops 投票卡片关闭；Live 控制台仍用 SSE |
```

- [ ] **Step 2b: Enable WebSocket upgrade in the production nginx**

In `deploy/plus/nginx.conf`, the `/api/` location gains:

```nginx
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
```

Keep the existing SSE settings (`proxy_buffering off`, long read timeout); WebSocket
and SSE share the location.

- [ ] **Step 3: Run all gates**

```powershell
Set-Location "C:\Users\16275\Desktop\ArtFlow"
pwsh -NoProfile -File scripts/check_docs.ps1
$env:PYTHONIOENCODING="utf-8"
uv run pytest tests/gates -q
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
$env:REQUIRE_DB = "1"
Set-Location "C:\Users\16275\Desktop\ArtFlow"
pnpm -C plus run check
pnpm -C plus run test
```
Expected: all PASS, including the new gate and E2E.

- [ ] **Step 4: Verify the production bundle**

```powershell
Set-Location "C:\Users\16275\Desktop\ArtFlow\plus"
pnpm --filter @artflow-plus/api build:bundle
node -e "require('./apps/api/dist/main.cjs')" --help 2>&1 | Select-Object -First 5
```
Expected: the bundle builds; the process starts and prints the missing-database error
(proving `ws` is bundled and loadable). Do not run it against production.

- [ ] **Step 5: Commit and integrate**

```powershell
git add docs/architecture/adr/0027-realtime-core.md docs/invariants/realtime.md docs/artflow-plus/roadmap.md docs/artflow-plus/shape-validation.md deploy/plus/nginx.conf
git commit -m "docs: record the realtime core and voting UI"
git checkout artflow-plus
git merge --no-ff feat/plus-realtime -m "merge: realtime core and voting UI"
git push origin artflow-plus
```

---

## Self-review checklist

- Spec coverage: protocol (Task 1), server (Task 2), client (Task 3), gate/CORE
  (Task 4), API/read model/topic (Task 5), web hook/card/E2E (Task 6), docs/gates
  (Task 7).
- No placeholders: every step names files, commands, and expected results.
- Core invariants appear in code: notification-only handler, versioned envelope,
  per-topic authz, snapshot+seq, bounds, heartbeat, `shouldSend`, gate, CORE.md.
- Client/server types line up: `RealtimeActor`, `RealtimeTopic`, `ServerMessage`,
  `VotingSessionsSnapshotSchema`.

