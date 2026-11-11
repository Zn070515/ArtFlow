import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import type { DynamicDependencies, ResolvedDynamicDependencies } from "./dynamic.js";
import { emptyDynamicDependencies, resolveDynamicDependencies } from "./dynamic.js";
import {
  enclosingSymbol,
  escapeRegExp,
  extractImports,
  extractRoutes,
  extractSymbols,
  findMatching,
  LineMap,
  maskCode,
  objectKeys,
  parseObjectFields,
  splitTopLevel,
  stringArray,
  stringLiteral,
} from "./scan.js";
import type { ImportSpec, RouteDecl, SymbolDecl } from "./scan.js";
import {
  capabilityNodeId,
  commandNodeId,
  eventNodeId,
  fileNodeId,
  moduleNodeId,
  routeNodeId,
  sortGraph,
  symbolNodeId,
  tableNodeId,
  topicNodeId,
} from "./schema.js";
import type {
  ConsumerGraph,
  EdgeKind,
  GraphEdge,
  GraphNode,
  SourceFile,
  UnresolvedReference,
} from "./schema.js";

const ENGINE_EVENTS = new Set([
  "ExecutionSessionStarted",
  "ExecutionSessionClosed",
]);
const ENGINE_EVENT_PREFIXES = ["Activity", "Definition"];
const ENGINE_COMMAND_PREFIXES = ["activity.", "definition.", "execution.", "runtime."];

interface FileContext {
  readonly file: SourceFile;
  readonly lineMap: LineMap;
  readonly masked: string;
  readonly symbols: readonly SymbolDecl[];
  readonly symbolNodes: ReadonlyMap<string, GraphNode>;
  readonly imports: readonly ImportSpec[];
  readonly bindings: Map<string, GraphNode | null>;
  readonly strictBindings: Set<string>;
}

interface PackageExport {
  readonly name: string;
  readonly file: string;
}

function normalizePath(value: string): string {
  return value.split(path.sep).join("/");
}

function readdir(pathname: string): string[] {
  try {
    return readdirSync(pathname);
  } catch {
    return [];
  }
}

function isSourceFile(file: string): boolean {
  return /\.(ts|tsx)$/.test(file) && !/\.(test|spec)\.(ts|tsx)$/.test(file) && !/\.d\.ts$/.test(file);
}

function walkSourceFiles(root: string, relative: string, output: string[]): void {
  const absolute = path.join(root, relative);
  let stats;
  try {
    stats = statSync(absolute);
  } catch {
    return;
  }
  if (!stats.isDirectory()) {
    if (isSourceFile(relative)) output.push(normalizePath(relative));
    return;
  }
  for (const entry of readdir(absolute)) {
    if (entry === "node_modules" || entry === "dist" || entry === "test-results") continue;
    walkSourceFiles(root, path.join(relative, entry), output);
  }
}

/** Reads every application and package source file under `apps/<name>/src` and `packages/<name>/src`. */
export function readSourceFiles(root: string): SourceFile[] {
  const paths: string[] = [];
  for (const group of ["apps", "packages"]) {
    for (const entry of readdir(path.join(root, group))) {
      walkSourceFiles(root, path.join(group, entry, "src"), paths);
    }
  }
  return paths
    .sort()
    .map((file) => ({ path: normalizePath(file), text: readFileSync(path.join(root, file), "utf8") }));
}

function packageName(root: string, packageDir: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(path.join(root, "packages", packageDir, "package.json"), "utf8")) as {
      name?: unknown;
    };
    return typeof raw.name === "string" ? raw.name : null;
  } catch {
    return null;
  }
}

function packageRoots(root: string): Map<string, string> {
  const roots = new Map<string, string>();
  for (const entry of readdir(path.join(root, "packages"))) {
    const name = packageName(root, entry);
    if (name !== null) roots.set(name, `packages/${entry}`);
  }
  return roots;
}

function resolveRelative(
  from: string,
  specifier: string,
  files: ReadonlySet<string>,
): string | null {
  if (!specifier.startsWith(".")) return null;
  if (specifier.endsWith(".json")) return null;
  const base = normalizePath(path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier)));
  const withoutExtension = base.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "");
  const candidates = [
    withoutExtension,
    `${withoutExtension}.ts`,
    `${withoutExtension}.tsx`,
    `${withoutExtension}/index.ts`,
    `${withoutExtension}/index.tsx`,
  ];
  for (const candidate of candidates) {
    if (files.has(candidate)) return candidate;
  }
  return null;
}

interface BuilderState {
  readonly root: string;
  files: ReadonlyMap<string, FileContext>;
  readonly nodes: Map<string, GraphNode>;
  readonly edges: Map<string, GraphEdge>;
  readonly unresolved: UnresolvedReference[];
  readonly warnings: Set<string>;
  readonly commandProviders: Map<string, Set<string>>;
  readonly declaredCommands: Set<string>;
  readonly declaredEvents: Set<string>;
  readonly emittedEvents: Set<string>;
  readonly dynamicCommandProviders: Set<string>;
  readonly dynamicEventProviders: Set<string>;
  packageExports: ReadonlyMap<string, ReadonlyMap<string, PackageExport>>;
}

function addNode(state: BuilderState, node: GraphNode): GraphNode {
  const existing = state.nodes.get(node.id);
  if (existing !== undefined) {
    if (existing.file === undefined && node.file !== undefined) {
      state.nodes.set(node.id, node);
      return node;
    }
    return existing;
  }
  state.nodes.set(node.id, node);
  return node;
}

function edgeKey(edge: GraphEdge, deduplicateCallSites: boolean): string {
  if (deduplicateCallSites) return `${edge.from}|${edge.to}|${edge.kind}`;
  return `${edge.from}|${edge.to}|${edge.kind}|${edge.file ?? ""}|${edge.line ?? 0}`;
}

function addEdge(state: BuilderState, edge: GraphEdge, deduplicateCallSites = false): void {
  const key = edgeKey(edge, deduplicateCallSites);
  if (!state.edges.has(key)) state.edges.set(key, edge);
}

function unresolved(
  state: BuilderState,
  entry: UnresolvedReference,
): void {
  state.unresolved.push(entry);
}

function warn(state: BuilderState, message: string): void {
  state.warnings.add(message);
}

function buildPackageExports(
  state: BuilderState,
  roots: ReadonlyMap<string, string>,
): Map<string, ReadonlyMap<string, PackageExport>> {
  const result = new Map<string, ReadonlyMap<string, PackageExport>>();
  const files = new Set(state.files.keys());

  const exportedNames = (file: string): Map<string, PackageExport> => {
    const context = state.files.get(file);
    const output = new Map<string, PackageExport>();
    if (context === undefined) return output;
    for (const symbol of context.symbols) {
      if (!symbol.exported) continue;
      const id = symbolNodeId(file, symbol.name);
      if (state.nodes.has(id)) output.set(symbol.name, { name: symbol.name, file });
    }
    return output;
  };

  const collect = (file: string, seen: Set<string>): Map<string, PackageExport> => {
    if (seen.has(file)) return new Map();
    seen.add(file);
    const context = state.files.get(file);
    if (context === undefined) return new Map();
    const output = new Map<string, PackageExport>();
    for (const [name, entry] of exportedNames(file)) output.set(name, entry);
    for (const specifier of context.imports.filter((item) => item.reexport)) {
      const target = resolveRelative(file, specifier.specifier, files);
      if (target === null) continue;
      for (const [name, entry] of collect(target, seen)) {
        if (!output.has(name)) output.set(name, entry);
      }
    }
    return output;
  };

  for (const [name, packageRoot] of roots) {
    for (const [specifier, file] of packageEntrypoints(state.root, packageRoot, name)) {
      if (!files.has(file)) continue;
      result.set(specifier, collect(file, new Set()));
    }
  }
  return result;
}

function entryTarget(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const fallback = (value as { default?: unknown }).default;
    if (typeof fallback === "string") return fallback;
  }
  return null;
}

function packageEntrypoints(
  root: string,
  packageRoot: string,
  name: string,
): [string, string][] {
  const entries: [string, string][] = [];
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(readFileSync(path.join(root, packageRoot, "package.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return [[name, `${packageRoot}/src/index.ts`]];
  }
  const exportsField = raw.exports;
  if (typeof exportsField === "object" && exportsField !== null && !Array.isArray(exportsField)) {
    for (const [key, value] of Object.entries(exportsField)) {
      const target = entryTarget(value);
      if (target === null) continue;
      const specifier = key === "." ? name : `${name}/${key.replace(/^\.\//, "")}`;
      const file = normalizePath(path.posix.join(packageRoot, target.replace(/^\.\//, "")));
      entries.push([specifier, file]);
    }
  }
  if (!entries.some(([specifier]) => specifier === name)) {
    const main = typeof raw.main === "string" ? raw.main : "./src/index.ts";
    entries.push([name, normalizePath(path.posix.join(packageRoot, main.replace(/^\.\//, "")))]);
  }
  return entries;
}

function createFileContext(state: BuilderState, file: SourceFile): FileContext {
  const lineMap = new LineMap(file.text);
  const masked = maskCode(file.text);
  const symbols = extractSymbols(masked);
  const imports = extractImports(file.text, masked);
  const symbolNodes = new Map<string, GraphNode>();
  for (const symbol of symbols) {
    if (symbolNodes.has(symbol.name)) continue;
    const node = addNode(state, {
      id: symbolNodeId(file.path, symbol.name),
      kind: "symbol",
      name: symbol.name,
      file: file.path,
      line: lineMap.line(symbol.index),
    });
    symbolNodes.set(symbol.name, node);
  }
  return {
    file,
    lineMap,
    masked,
    symbols,
    symbolNodes,
    imports,
    bindings: new Map(),
    strictBindings: new Set(),
  };
}

function bindSymbols(state: BuilderState): void {
  for (const context of state.files.values()) {
    for (const symbol of context.symbols) {
      const node = context.symbolNodes.get(symbol.name);
      if (node !== undefined) context.bindings.set(symbol.name, node);
    }
  }

  for (const context of state.files.values()) {
    for (const specifier of context.imports) {
      if (specifier.names.length === 0) continue;
      const relative = resolveRelative(context.file.path, specifier.specifier, new Set(state.files.keys()));
      const packageExport = relative === null ? state.packageExports.get(specifier.specifier) : undefined;
      const strict = relative !== null || specifier.specifier.startsWith("@artflow-plus/");
      for (const imported of specifier.names) {
        let target: GraphNode | undefined;
        if (relative !== null) {
          const targetContext = state.files.get(relative);
          target = targetContext?.symbolNodes.get(imported.imported);
        } else if (packageExport !== undefined) {
          const entry = packageExport.get(imported.imported);
          if (entry !== undefined) {
            target = state.nodes.get(symbolNodeId(entry.file, entry.name));
          }
        }
        context.bindings.set(imported.local, target ?? null);
        if (target === undefined && strict) context.strictBindings.add(imported.local);
      }
    }
  }
}

function addImportEdges(state: BuilderState): void {
  const files = new Set(state.files.keys());
  for (const context of state.files.values()) {
    const from = fileNodeId(context.file.path);
    for (const specifier of context.imports) {
      if (/\.(css|scss|sass|less|svg|png|jpe?g|gif|webp|ico|json|wasm|html)$/i.test(specifier.specifier)) {
        continue;
      }
      const target = resolveRelative(context.file.path, specifier.specifier, files);
      if (target !== null) {
        addNode(state, { id: fileNodeId(target), kind: "file", name: target, file: target });
        addEdge(state, { from, to: fileNodeId(target), kind: "imports", file: context.file.path, line: context.lineMap.line(specifier.index) }, true);
        continue;
      }
      if (specifier.specifier.startsWith(".")) {
        unresolved(state, {
          kind: "import",
          value: specifier.specifier,
          file: context.file.path,
          line: context.lineMap.line(specifier.index),
          reason: "Relative import does not resolve to a source file.",
        });
        continue;
      }
      addNode(state, {
        id: moduleNodeId(specifier.specifier),
        kind: "module",
        name: specifier.specifier,
      });
      addEdge(state, { from, to: moduleNodeId(specifier.specifier), kind: "imports", file: context.file.path, line: context.lineMap.line(specifier.index) }, true);
    }
  }
}

function addCallEdges(state: BuilderState): void {
  for (const context of state.files.values()) {
    const from = fileNodeId(context.file.path);
    const reported = new Set<string>();
    for (const [name, target] of context.bindings) {
      const pattern = new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`, "g");
      for (const match of context.masked.matchAll(pattern)) {
        if (match.index === undefined) continue;
        if (/function\s+$/.test(context.masked.slice(Math.max(0, match.index - 20), match.index))) {
          continue;
        }
        if (target === null) {
          if (context.strictBindings.has(name) && !reported.has(name)) {
            reported.add(name);
            unresolved(state, {
              kind: "binding",
              value: name,
              file: context.file.path,
              line: context.lineMap.line(match.index),
              reason: "Called identifier is imported but could not be resolved to a source symbol.",
            });
          }
          continue;
        }
        addEdge(state, {
          from,
          to: target.id,
          kind: "calls",
          file: context.file.path,
          line: context.lineMap.line(match.index),
        }, true);
      }
    }
  }
}

function objectArgument(args: string): string | null {
  for (const part of splitTopLevel(args, ",")) {
    if (part.trim().startsWith("{")) return part.trim();
  }
  return null;
}

function addCommandCalls(state: BuilderState): void {
  for (const context of state.files.values()) {
    const from = fileNodeId(context.file.path);
    for (const match of context.masked.matchAll(/\bexecuteCommand\s*\(/g)) {
      if (match.index === undefined) continue;
      if (/function\s+$/.test(context.masked.slice(Math.max(0, match.index - 20), match.index))) continue;
      const open = context.masked.indexOf("(", match.index);
      if (open === -1) continue;
      const close = findMatching(context.file.text, open);
      if (close === -1) continue;
      const literal = objectArgument(context.file.text.slice(open + 1, close - 1));
      if (literal === null) {
        unresolved(state, {
          kind: "command",
          value: "executeCommand",
          file: context.file.path,
          line: context.lineMap.line(match.index),
          reason: "executeCommand call has no object-literal metadata argument.",
        });
        continue;
      }
      const fields = parseObjectFields(literal);
      const commandType = stringLiteral(fields.get("commandType"));
      const capability = stringLiteral(fields.get("capability"));
      const line = context.lineMap.line(match.index);
      const provider = enclosingSymbol(context.symbols, match.index);
      const providerNode =
        provider === undefined ? state.nodes.get(from) : context.symbolNodes.get(provider.name);
      const providerId = providerNode?.id ?? from;
      if (commandType === null) {
        if (state.dynamicCommandProviders.has(providerId)) continue;
        unresolved(state, {
          kind: "command",
          value: "executeCommand",
          file: context.file.path,
          line,
          reason: "executeCommand metadata has no literal commandType.",
        });
        continue;
      }
      const command = addNode(state, { id: commandNodeId(commandType), kind: "command", name: commandType });
      const providers = state.commandProviders.get(commandType) ?? new Set<string>();
      providers.add(providerId);
      state.commandProviders.set(commandType, providers);
      addEdge(state, {
        from: providerId,
        to: command.id,
        kind: "invokes-command",
        file: context.file.path,
        line,
      }, true);
      if (capability !== null) {
        const capabilityNode = addNode(state, {
          id: capabilityNodeId(capability),
          kind: "capability",
          name: capability,
        });
        addEdge(state, { from: capabilityNode.id, to: command.id, kind: "declares", file: context.file.path, line }, true);
      }
    }
  }
}

function addEventCalls(state: BuilderState): void {
  for (const context of state.files.values()) {
    const from = fileNodeId(context.file.path);
    for (const match of context.masked.matchAll(/\bappendEngineEvent\s*\(/g)) {
      if (match.index === undefined) continue;
      if (/function\s+$/.test(context.masked.slice(Math.max(0, match.index - 20), match.index))) continue;
      const open = context.masked.indexOf("(", match.index);
      if (open === -1) continue;
      const close = findMatching(context.file.text, open);
      if (close === -1) continue;
      const literal = objectArgument(context.file.text.slice(open + 1, close - 1));
      if (literal === null) {
        unresolved(state, {
          kind: "event",
          value: "appendEngineEvent",
          file: context.file.path,
          line: context.lineMap.line(match.index),
          reason: "appendEngineEvent call has no object-literal event argument.",
        });
        continue;
      }
      const fields = parseObjectFields(literal);
      const eventType = stringLiteral(fields.get("type"));
      const capability = stringLiteral(fields.get("capability"));
      const line = context.lineMap.line(match.index);
      const provider = enclosingSymbol(context.symbols, match.index);
      const providerNode =
        provider === undefined ? state.nodes.get(from) : context.symbolNodes.get(provider.name);
      const providerId = providerNode?.id ?? from;
      if (eventType === null) {
        if (state.dynamicEventProviders.has(providerId)) continue;
        unresolved(state, {
          kind: "event",
          value: "appendEngineEvent",
          file: context.file.path,
          line,
          reason: "appendEngineEvent payload has no literal type.",
        });
        continue;
      }
      const event = addNode(state, { id: eventNodeId(eventType), kind: "event", name: eventType });
      state.emittedEvents.add(eventType);
      addEdge(state, { from: providerId, to: event.id, kind: "emits", file: context.file.path, line }, true);
      if (capability !== null) {
        const capabilityNode = addNode(state, {
          id: capabilityNodeId(capability),
          kind: "capability",
          name: capability,
        });
        addEdge(state, { from: capabilityNode.id, to: event.id, kind: "declares", file: context.file.path, line }, true);
      }
    }
  }
}

function addCapabilities(state: BuilderState): void {
  for (const context of state.files.values()) {
    if (!context.file.path.startsWith("packages/domain/src/capabilities/")) continue;
    for (const match of context.masked.matchAll(/\bmanifest\s*:\s*\{/g)) {
      if (match.index === undefined) continue;
      const open = context.masked.indexOf("{", match.index);
      if (open === -1) continue;
      const close = findMatching(context.file.text, open);
      if (close === -1) continue;
      const fields = parseObjectFields(context.file.text.slice(open, close));
      const identity = stringLiteral(fields.get("identity"));
      if (identity === null) {
        unresolved(state, {
          kind: "capability",
          value: context.file.path,
          file: context.file.path,
          line: context.lineMap.line(match.index),
          reason: "Capability manifest has no literal identity.",
        });
        continue;
      }
      const capability = addNode(state, {
        id: capabilityNodeId(identity),
        kind: "capability",
        name: identity,
        file: context.file.path,
        line: context.lineMap.line(match.index),
      });
      for (const commandType of stringArray(fields.get("commands"))) {
        const command = addNode(state, { id: commandNodeId(commandType), kind: "command", name: commandType });
        state.declaredCommands.add(commandType);
        addEdge(state, { from: capability.id, to: command.id, kind: "declares", file: context.file.path, line: context.lineMap.line(match.index) }, true);
      }
      for (const eventType of stringArray(fields.get("events"))) {
        const event = addNode(state, { id: eventNodeId(eventType), kind: "event", name: eventType });
        state.declaredEvents.add(eventType);
        addEdge(state, { from: capability.id, to: event.id, kind: "declares", file: context.file.path, line: context.lineMap.line(match.index) }, true);
      }
      for (const dependency of stringArray(fields.get("dependencies"))) {
        const target = addNode(state, { id: capabilityNodeId(dependency), kind: "capability", name: dependency });
        addEdge(state, { from: capability.id, to: target.id, kind: "depends-on", file: context.file.path, line: context.lineMap.line(match.index) }, true);
      }
      for (const commandType of objectKeys(fields.get("commandScopes"))) {
        const command = addNode(state, { id: commandNodeId(commandType), kind: "command", name: commandType });
        addEdge(state, { from: capability.id, to: command.id, kind: "declares", file: context.file.path, line: context.lineMap.line(match.index) }, true);
      }
    }
  }
}

function firstResolvedCall(
  state: BuilderState,
  context: FileContext,
  body: string,
): GraphNode | null {
  for (const match of maskCode(body).matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = match[1];
    if (name === undefined) continue;
    if (["if", "for", "while", "switch", "return", "await", "typeof", "Promise", "Number", "String"].includes(name)) continue;
    const binding = context.bindings.get(name);
    if (binding !== null && binding !== undefined) return binding;
    const exported = state.packageExports.get("@artflow-plus/runtime")?.get(name);
    if (exported !== undefined) {
      return state.nodes.get(symbolNodeId(exported.file, exported.name)) ?? null;
    }
  }
  return null;
}

function addTopics(state: BuilderState): void {
  for (const context of state.files.values()) {
    if (!context.file.path.startsWith("apps/api/src/")) continue;
    for (const match of context.file.text.matchAll(/\bnamespace\s*:\s*["']([^"']+)["']/g)) {
      const namespace = match[1];
      if (namespace === undefined || match.index === undefined) continue;
      if (context.masked[match.index] === " ") continue;
      const snapshot = context.masked.indexOf("snapshot", match.index);
      if (snapshot === -1) continue;
      const open = context.masked.indexOf("(", snapshot);
      if (open === -1) continue;
      const paramsClose = findMatching(context.file.text, open);
      if (paramsClose === -1) continue;
      const bodyOpen = context.file.text.indexOf("{", paramsClose - 1);
      if (bodyOpen === -1) continue;
      const bodyClose = findMatching(context.file.text, bodyOpen);
      if (bodyClose === -1) continue;
      const body = context.file.text.slice(bodyOpen + 1, bodyClose - 1);
      const source = firstResolvedCall(state, context, body);
      const topic = addNode(state, {
        id: topicNodeId(namespace),
        kind: "topic",
        name: namespace,
        file: context.file.path,
        line: context.lineMap.line(match.index),
      });
      if (source === null) {
        unresolved(state, {
          kind: "topic",
          value: namespace,
          file: context.file.path,
          line: context.lineMap.line(match.index),
          reason: "Realtime topic snapshot does not resolve to a source symbol.",
        });
        continue;
      }
      addEdge(state, { from: topic.id, to: source.id, kind: "subscribes", file: context.file.path, line: context.lineMap.line(snapshot) }, true);
    }
  }
}

function addRoutes(state: BuilderState): void {
  for (const context of state.files.values()) {
    if (!context.file.path.startsWith("apps/api/src/routes/")) continue;
    for (const route of extractRoutes(context.file.text, context.masked)) {
      const node = addNode(state, {
        id: routeNodeId(route.method, route.url),
        kind: "route",
        name: `${route.method} ${route.url}`,
        file: context.file.path,
        line: context.lineMap.line(route.index),
      });
      const maskedInner = maskCode(route.inner);
      for (const [name, target] of context.bindings) {
        if (target === null) continue;
        const pattern = new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`, "g");
        if (pattern.test(maskedInner)) {
          addEdge(state, { from: node.id, to: target.id, kind: "serves", file: context.file.path, line: context.lineMap.line(route.index) }, true);
        }
      }
    }
  }
}

function addTables(state: BuilderState): void {
  for (const context of state.files.values()) {
    if (!context.file.path.startsWith("packages/db/src/")) continue;
    for (const match of context.file.text.matchAll(/\.(selectFrom|insertInto|updateTable|deleteFrom)\(\s*["']([A-Za-z0-9_]+)["']/g)) {
      const operation = match[1];
      const table = match[2];
      if (operation === undefined || table === undefined || match.index === undefined) continue;
      if (context.masked[match.index] === " ") continue;
      const node = addNode(state, { id: tableNodeId(table), kind: "table", name: table });
      addEdge(state, {
        from: fileNodeId(context.file.path),
        to: node.id,
        kind: operation === "selectFrom" ? "reads" : "writes",
        file: context.file.path,
        line: context.lineMap.line(match.index),
      }, true);
    }
  }
}

function addDynamicConsumers(
  state: BuilderState,
  resolved: ResolvedDynamicDependencies,
): void {
  for (const entry of resolved.unresolved) unresolved(state, entry);

  for (const consumer of resolved.eventConsumers) {
    const event = addNode(state, {
      id: eventNodeId(consumer.eventType),
      kind: "event",
      name: consumer.eventType,
    });
    addEdge(state, {
      from: consumer.consumerId,
      to: event.id,
      kind: "consumes",
      line: undefined,
    }, true);
  }

  for (const command of resolved.commands) {
    const node = addNode(state, {
      id: commandNodeId(command.commandType),
      kind: "command",
      name: command.commandType,
    });
    addEdge(state, {
      from: command.providerId,
      to: node.id,
      kind: "invokes-command",
      line: undefined,
    }, true);
    const providers = state.commandProviders.get(command.commandType) ?? new Set<string>();
    providers.add(command.providerId);
    state.commandProviders.set(command.commandType, providers);
  }

  for (const provider of resolved.eventProviders) {
    warn(
      state,
      `Dynamic event provider emits event types at runtime and cannot be listed statically: ${provider.providerId} (${provider.reason}).`,
    );
  }
}

function validate(state: BuilderState): void {
  for (const [commandType, providers] of state.commandProviders) {
    if (providers.size > 1) {
      unresolved(state, {
        kind: "command",
        value: commandType,
        reason: `Command is invoked by more than one provider: ${[...providers].sort().join(", ")}.`,
      });
    }
  }
  for (const commandType of state.declaredCommands) {
    if (!state.commandProviders.has(commandType)) {
      warn(state, `Declared command has no executeCommand provider in the source tree: ${commandType}.`);
    }
  }
  for (const commandType of state.commandProviders.keys()) {
    if (
      !state.declaredCommands.has(commandType) &&
      !ENGINE_COMMAND_PREFIXES.some((prefix) => commandType.startsWith(prefix))
    ) {
      warn(state, `Command provider is not declared by any capability manifest: ${commandType}.`);
    }
  }
  for (const eventType of state.emittedEvents) {
    if (
      !state.declaredEvents.has(eventType) &&
      !ENGINE_EVENTS.has(eventType) &&
      !ENGINE_EVENT_PREFIXES.some((prefix) => eventType.startsWith(prefix))
    ) {
      warn(state, `Emitted event is not declared by any capability manifest: ${eventType}.`);
    }
  }
  for (const eventType of state.declaredEvents) {
    if (!state.emittedEvents.has(eventType)) {
      warn(state, `Declared event has no appendEngineEvent producer in the source tree: ${eventType}.`);
    }
  }
}

function buildState(root: string, files: readonly SourceFile[]): BuilderState {
  const state: BuilderState = {
    root,
    files: new Map(),
    nodes: new Map(),
    edges: new Map(),
    unresolved: [],
    warnings: new Set(),
    commandProviders: new Map(),
    declaredCommands: new Set(),
    declaredEvents: new Set(),
    emittedEvents: new Set(),
    dynamicCommandProviders: new Set(),
    dynamicEventProviders: new Set(),
    packageExports: new Map(),
  };
  const sourceMap = new Map<string, SourceFile>();
  for (const file of files) {
    sourceMap.set(file.path, file);
    addNode(state, { id: fileNodeId(file.path), kind: "file", name: file.path, file: file.path });
  }
  const contexts = new Map<string, FileContext>();
  for (const file of files) contexts.set(file.path, createFileContext(state, file));
  state.files = contexts;
  state.packageExports = buildPackageExports(state, packageRoots(root));
  return state;
}

export function buildGraphFromSources(
  sources: readonly SourceFile[],
  dynamic: DynamicDependencies = emptyDynamicDependencies(),
  root = ".",
  displayRoot = root,
): ConsumerGraph {
  const state = buildState(root, sources);
  const dynamicResolved = resolveDynamicDependencies(dynamic, (id) => state.nodes.has(id));
  for (const command of dynamicResolved.commands) state.dynamicCommandProviders.add(command.providerId);
  for (const provider of dynamicResolved.eventProviders) state.dynamicEventProviders.add(provider.providerId);
  bindSymbols(state);
  addImportEdges(state);
  addCallEdges(state);
  addCommandCalls(state);
  addEventCalls(state);
  addCapabilities(state);
  addTopics(state);
  addRoutes(state);
  addTables(state);
  addDynamicConsumers(state, dynamicResolved);
  validate(state);
  const sorted = sortGraph(
    [...state.nodes.values()],
    [...state.edges.values()],
    state.unresolved,
    state.warnings,
  );
  return {
    version: 1,
    root: displayRoot,
    nodes: sorted.nodes,
    edges: sorted.edges,
    unresolved: sorted.unresolved,
    warnings: sorted.warnings,
  };
}

export function buildConsumerGraph(
  root: string,
  dynamic: DynamicDependencies = emptyDynamicDependencies(),
): ConsumerGraph {
  return buildGraphFromSources(readSourceFiles(root), dynamic, root, ".");
}
