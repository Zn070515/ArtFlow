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
