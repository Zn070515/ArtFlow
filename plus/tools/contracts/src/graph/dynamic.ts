import { readFileSync } from "node:fs";

import type { UnresolvedReference } from "./schema.js";
import { symbolNodeId } from "./schema.js";

export interface EventConsumerDeclaration {
  readonly eventType: string;
  readonly consumer: string;
  readonly reason: string;
}

export interface CommandDeclaration {
  readonly commandType: string;
  readonly provider: string;
  readonly reason: string;
}

export interface EventProviderDeclaration {
  readonly provider: string;
  readonly reason: string;
}

export interface DynamicDependencies {
  readonly version: 1;
  readonly eventConsumers: readonly EventConsumerDeclaration[];
  readonly commands: readonly CommandDeclaration[];
  readonly eventProviders: readonly EventProviderDeclaration[];
}

const DEFAULT_DYNAMIC_DEPENDENCIES: DynamicDependencies = {
  version: 1,
  eventConsumers: [],
  commands: [],
  eventProviders: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(entry: Record<string, unknown>, key: string, label: string): string {
  const value = entry[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} needs a non-empty ${key}.`);
  }
  return value;
}

function requiredSymbol(entry: Record<string, unknown>, key: string, label: string): string {
  const value = requiredString(entry, key, label);
  if (!value.includes("#")) throw new Error(`${label}.${key} must be "path#symbol".`);
  return value;
}

function arrayField(raw: Record<string, unknown>, key: string): unknown[] {
  const value = raw[key];
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`dynamic-dependencies.json ${key} must be an array.`);
  return value;
}

/** Parses and validates the declared dynamic seams. */
export function parseDynamicDependencies(raw: unknown): DynamicDependencies {
  if (!isRecord(raw) || raw.version !== 1) {
    throw new Error("dynamic-dependencies.json must be an object with version: 1.");
  }

  const eventConsumers: EventConsumerDeclaration[] = [];
  for (const entry of arrayField(raw, "eventConsumers")) {
    if (!isRecord(entry)) throw new Error("Every eventConsumer must be an object.");
    const eventType = requiredString(entry, "eventType", "eventConsumer");
    eventConsumers.push({
      eventType,
      consumer: requiredSymbol(entry, "consumer", `eventConsumer ${eventType}`),
      reason: requiredString(entry, "reason", `eventConsumer ${eventType}`),
    });
  }

  const commands: CommandDeclaration[] = [];
  for (const entry of arrayField(raw, "commands")) {
    if (!isRecord(entry)) throw new Error("Every command declaration must be an object.");
    const commandType = requiredString(entry, "commandType", "command declaration");
    commands.push({
      commandType,
      provider: requiredSymbol(entry, "provider", `command ${commandType}`),
      reason: requiredString(entry, "reason", `command ${commandType}`),
    });
  }

  const eventProviders: EventProviderDeclaration[] = [];
  for (const entry of arrayField(raw, "eventProviders")) {
    if (!isRecord(entry)) throw new Error("Every eventProvider must be an object.");
    const provider = requiredSymbol(entry, "provider", "eventProvider");
    eventProviders.push({
      provider,
      reason: requiredString(entry, "reason", `eventProvider ${provider}`),
    });
  }

  return { version: 1, eventConsumers, commands, eventProviders };
}

export function loadDynamicDependencies(path: string): DynamicDependencies {
  const text = readFileSync(path, "utf8");
  return parseDynamicDependencies(JSON.parse(text) as unknown);
}

export function emptyDynamicDependencies(): DynamicDependencies {
  return DEFAULT_DYNAMIC_DEPENDENCIES;
}

function refToSymbolId(reference: string): string {
  const separator = reference.lastIndexOf("#");
  return symbolNodeId(reference.slice(0, separator), reference.slice(separator + 1));
}

export interface ResolvedDynamicDependencies {
  readonly eventConsumers: readonly { readonly eventType: string; readonly consumerId: string; readonly reason: string }[];
  readonly commands: readonly { readonly commandType: string; readonly providerId: string; readonly reason: string }[];
  readonly eventProviders: readonly { readonly providerId: string; readonly reason: string }[];
  readonly unresolved: readonly UnresolvedReference[];
}

export function resolveDynamicDependencies(
  dynamic: DynamicDependencies,
  hasSymbol: (id: string) => boolean,
): ResolvedDynamicDependencies {
  const unresolved: UnresolvedReference[] = [];

  const eventConsumers = dynamic.eventConsumers.flatMap((entry) => {
    const consumerId = refToSymbolId(entry.consumer);
    if (!hasSymbol(consumerId)) {
      unresolved.push({
        kind: "dynamic",
        value: entry.consumer,
        reason: `Event consumer declaration for ${entry.eventType} does not resolve to a symbol.`,
      });
      return [];
    }
    return [{ eventType: entry.eventType, consumerId, reason: entry.reason }];
  });

  const commands = dynamic.commands.flatMap((entry) => {
    const providerId = refToSymbolId(entry.provider);
    if (!hasSymbol(providerId)) {
      unresolved.push({
        kind: "dynamic",
        value: entry.provider,
        reason: `Dynamic command ${entry.commandType} provider does not resolve to a symbol.`,
      });
      return [];
    }
    return [{ commandType: entry.commandType, providerId, reason: entry.reason }];
  });

  const eventProviders = dynamic.eventProviders.flatMap((entry) => {
    const providerId = refToSymbolId(entry.provider);
    if (!hasSymbol(providerId)) {
      unresolved.push({
        kind: "dynamic",
        value: entry.provider,
        reason: "Dynamic event provider does not resolve to a symbol.",
      });
      return [];
    }
    return [{ providerId, reason: entry.reason }];
  });

  return { eventConsumers, commands, eventProviders, unresolved };
}
