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
