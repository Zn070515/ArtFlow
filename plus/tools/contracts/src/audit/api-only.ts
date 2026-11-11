import { readFileSync } from "node:fs";

import type { ConsumerGraph } from "../graph/schema.js";
import { routeNodeId } from "../graph/schema.js";

/**
 * Routes that intentionally have no Web caller. Each declaration is explicit:
 * a matching route must still exist and must carry a non-empty reason, so this
 * list cannot silently absorb product gaps.
 */
export interface ApiOnlyRoute {
  readonly method: string;
  readonly path: string;
  readonly reason: string;
}

export function apiOnlyKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

export function loadApiOnly(file: string): ApiOnlyRoute[] {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as {
    version?: unknown;
    routes?: unknown;
  };
  if (parsed.version !== 1 || !Array.isArray(parsed.routes)) {
    throw new Error("api-only.json must contain { version: 1, routes: [] }.");
  }
  return parsed.routes.map((entry) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error("Each api-only route must be an object.");
    }
    const { method, path, reason } = entry as Record<string, unknown>;
    if (typeof method !== "string" || typeof path !== "string" || typeof reason !== "string") {
      throw new Error("Each api-only route needs string method, path and reason.");
    }
    return { method: method.toUpperCase(), path, reason };
  });
}

export function validateApiOnly(
  routes: readonly ApiOnlyRoute[],
  graph: ConsumerGraph,
): readonly string[] {
  const known = new Set(graph.nodes.map((node) => node.id));
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const route of routes) {
    const key = apiOnlyKey(route.method, route.path);
    if (route.reason.trim() === "") problems.push(`${key}: reason must not be empty.`);
    if (seen.has(key)) problems.push(`${key}: declared more than once.`);
    seen.add(key);
    if (!known.has(routeNodeId(route.method, route.path))) {
      problems.push(`${key}: no such mutation route in the current tree.`);
    }
  }
  return problems;
}

export function apiOnlyKeys(routes: readonly ApiOnlyRoute[]): ReadonlySet<string> {
  return new Set(routes.map((route) => apiOnlyKey(route.method, route.path)));
}
