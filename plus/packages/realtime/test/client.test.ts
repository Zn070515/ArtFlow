import Fastify from "fastify";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { nextBackoff } from "../src/client/backoff.js";
import { createRealtimeClient } from "../src/client/client.js";
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
    await new Promise<void>((resolve) => raw.once("listening", () => resolve()));
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
