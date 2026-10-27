import { Value } from "@sinclair/typebox/value";
import type { WebSocket } from "ws";

import {
  ClientMessageSchema,
  type ClientMessage,
  type ServerMessage,
} from "../protocol/envelope.js";
import type { RealtimeActor, RealtimeTarget, RealtimeTopic } from "../protocol/topic.js";
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

const OPEN_STATE = 1;

interface Subscription {
  readonly definition: RealtimeTopic;
  readonly target: RealtimeTarget;
}

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
    const parsedTarget = definition.parse(topic);
    if (parsedTarget === null) {
      this.error(id, "UNKNOWN_TOPIC", "topic not found");
      return;
    }
    const target: RealtimeTarget = { topic, ...parsedTarget };
    if (!(await definition.authorize(this.actor, target))) {
      this.error(id, "FORBIDDEN", "not allowed to subscribe");
      return;
    }
    let snapshot;
    try {
      snapshot = await definition.snapshot(target);
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
    this.subscriptions.set(topic, { definition, target });
    this.hub.add(this, definition, target, snapshot.seq);
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
