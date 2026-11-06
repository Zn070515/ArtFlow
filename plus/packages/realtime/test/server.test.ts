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
      const rest = topic.split(":")[1];
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
  readonly heartbeatIntervalMs?: number;
  readonly heartbeatTimeoutMs?: number;
}) {
  const app = Fastify({ logger: false });
  const realtime = await createRealtimeServer({
    fastify: app,
    authenticate: options.authenticate ?? (async () => actor),
    topics: [options.topic ?? fakeTopic()],
    pollIntervalMs: options.pollIntervalMs ?? 20,
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? 2000,
    heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? 2000,
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  return { app, realtime, url: `ws://127.0.0.1:${address.port}/api/realtime` };
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

function open(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    inbox(socket);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
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
    const connection = new RealtimeConnection(socket, actor, new Map(), hub, logger, "c1", 1000);
    connection.ping();
    // Same-tick sweep: the timeout window has not elapsed yet.
    connection.checkAlive(Date.now() + 100);
    expect(socket.terminate).not.toHaveBeenCalled();
    connection.checkAlive(Date.now() + 2000);
    expect(socket.terminate).toHaveBeenCalledTimes(1);
  });

  it("keeps a ponging connection alive across heartbeat sweeps", async () => {
    const { app, realtime, url } = await listen({
      heartbeatIntervalMs: 20,
      heartbeatTimeoutMs: 200,
    });
    closers.push(async () => {
      await realtime.close();
      await app.close();
    });
    const socket = await open(url);
    await nextMessage(socket, (m) => m.type === "hello");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(socket.readyState).toBe(WebSocket.OPEN);
    socket.close();
  });
});
