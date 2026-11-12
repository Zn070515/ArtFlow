import {
  findMatching,
  LineMap,
  maskCode,
  splitTopLevel,
  stringLiteral,
} from "./scan.js";
import type { ConsumerGraph, GraphEdge, SourceFile } from "./schema.js";

export interface WebCall {
  readonly file: string;
  readonly method: string;
  readonly path: string;
  readonly line: number;
}

export interface UiGap {
  readonly method: string;
  readonly path: string;
  readonly file?: string;
  readonly line?: number;
}

/** Public, participant, or transport routes that intentionally have no console caller. */
const API_ONLY_PREFIXES = [
  "/api/auth/",
  "/api/public/",
  "/api/vote/",
  "/api/judge-entry/",
  "/api/judge/context",
  "/api/realtime",
  "/api/healthz",
  "/api/readyz",
  "/api/livez",
  "/api/system/",
];

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function pathPattern(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.startsWith("`") && trimmed.endsWith("`")) {
    return trimmed.slice(1, -1).replace(/\$\{[^}]*\}/g, ":param");
  }
  return stringLiteral(trimmed);
}

function normalizePath(path: string): string {
  const withoutQuery = path.split("?")[0]?.split("#")[0] ?? path;
  const segments = withoutQuery.split("/").filter(Boolean);
  return `/${segments.join("/")}`;
}

function segments(path: string): string[] {
  return path.split("/").filter(Boolean);
}

export function routeMatches(routePath: string, callPath: string): boolean {
  const route = segments(routePath);
  const call = segments(callPath);
  if (route.length !== call.length) return false;
  return route.every((segment, index) => {
    const candidate = call[index];
    if (candidate === undefined) return false;
    return (
      segment === candidate ||
      segment.startsWith(":") ||
      candidate === ":param"
    );
  });
}

/**
 * Extracts `apiFetch(...)` and `fetch(...)` calls whose first argument is a
 * literal or template path under `/api/`. A `${...}` segment is normalized to
 * `:param`, so it can be compared with Fastify's `:id` route parameters.
 */
export function extractWebCalls(files: readonly SourceFile[]): WebCall[] {
  const calls: WebCall[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    if (!file.path.startsWith("apps/web/src/")) continue;
    const masked = maskCode(file.text);
    const lineMap = new LineMap(file.text);
    for (const match of file.text.matchAll(/\b(?:apiFetch|fetch)\b/g)) {
      if (match.index === undefined || masked[match.index] === " ") continue;
      let cursor = match.index + match[0].length;
      while (/\s/.test(file.text[cursor] ?? "")) cursor += 1;
      // `apiFetch<Response>(...)`: skip the balanced generic argument list.
      if (file.text[cursor] === "<") {
        let depth = 0;
        while (cursor < file.text.length) {
          const char = file.text[cursor];
          if (char === "<") depth += 1;
          else if (char === ">") {
            depth -= 1;
            if (depth === 0) {
              cursor += 1;
              break;
            }
          }
          cursor += 1;
        }
        while (/\s/.test(file.text[cursor] ?? "")) cursor += 1;
      }
      if (file.text[cursor] !== "(") continue;
      const open = cursor;
      const close = findMatching(file.text, open);
      if (close === -1) continue;
      const args = file.text.slice(open + 1, close - 1);
      const first = splitTopLevel(args, ",")[0]?.trim();
      if (first === undefined || first === "") continue;
      const rawPath = pathPattern(first);
      if (rawPath === null || !rawPath.startsWith("/api/")) continue;
      const methodMatch = /method\s*:\s*["']([A-Za-z]+)["']/.exec(args);
      const method = (methodMatch?.[1] ?? "GET").toUpperCase();
      const path = normalizePath(rawPath);
      const line = lineMap.line(match.index);
      const key = `${file.path}|${method}|${path}|${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      calls.push({ file: file.path, method, path, line });
    }
  }
  return calls;
}

/**
 * Routes exercised by the HTTP-level journey runner are a product consumer too:
 * a data-driven journey is the substitute for a browser path when no Web caller
 * exists yet. The runner calls `app.inject({ method, url })` with a template URL.
 */
export function extractJourneyCalls(files: readonly SourceFile[]): WebCall[] {
  const calls: WebCall[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    if (!/^apps\/api\/test\/.*journey.*\.ts$/.test(file.path)) continue;
    const lineMap = new LineMap(file.text);
    const pattern = /app\.inject\s*\(\s*\{[\s\S]{0,400}?method:\s*["'](GET|POST|PUT|PATCH|DELETE)["'][\s\S]{0,400}?url:\s*(`[^`]+`|"[^"]+"|'[^']+')/g;
    for (const match of file.text.matchAll(pattern)) {
      const method = match[1];
      const raw = match[2];
      if (method === undefined || raw === undefined || match.index === undefined) continue;
      const rawPath = pathPattern(raw);
      if (rawPath === null || !rawPath.startsWith("/api/")) continue;
      const path = normalizePath(rawPath);
      const line = lineMap.line(match.index);
      const key = `${file.path}|${method}|${path}|${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      calls.push({ file: file.path, method, path, line });
    }
  }
  return calls;
}

/**
 * Mutation routes with no Web caller. This is deliberately a report, not a CI
 * failure: some routes are API-only, journey-driven, or consumed by a future
 * surface. It makes "API exists but no product path calls it" visible.
 */
export function findUnreferencedMutationRoutes(
  graph: ConsumerGraph,
  apiOnly: ReadonlySet<string> = new Set(),
): UiGap[] {
  const referenced = new Set(
    graph.edges
      .filter((edge): edge is GraphEdge & { kind: "consumes-route" } => edge.kind === "consumes-route")
      .map((edge) => edge.to),
  );
  const gaps: UiGap[] = [];
  for (const node of graph.nodes) {
    if (node.kind !== "route") continue;
    const [method, path] = node.name.split(" ", 2);
    if (method === undefined || path === undefined) continue;
    if (!MUTATION_METHODS.has(method)) continue;
    if (referenced.has(node.id)) continue;
    if (API_ONLY_PREFIXES.some((prefix) => path.startsWith(prefix))) continue;
    if (apiOnly.has(`${method} ${path}`)) continue;
    gaps.push({ method, path, ...(node.file === undefined ? {} : { file: node.file }), ...(node.line === undefined ? {} : { line: node.line }) });
  }
  return gaps.sort((left, right) =>
    `${left.method} ${left.path}` < `${right.method} ${right.path}` ? -1 : 1,
  );
}

export function formatUiGaps(gaps: readonly UiGap[]): string {
  if (gaps.length === 0) return "No unreferenced mutation routes found.\n";
  return [
    `Unreferenced mutation routes (${gaps.length}):`,
    ...gaps.map((gap) => `- ${gap.method} ${gap.path}${gap.file === undefined ? "" : ` (${gap.file}:${gap.line ?? 0})`}`),
    "",
  ].join("\n");
}
