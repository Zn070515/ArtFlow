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
