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
