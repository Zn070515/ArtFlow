/**
 * A deliberately small scanner. The repository pins `typescript@7`, the native
 * compiler, which does not expose `createSourceFile` or `createProgram`. The
 * graph therefore extracts only the syntax it owns: imports, call sites with
 * literal object fields, capability manifests, realtime topics, routes, and
 * repository table names. Anything else is a declared dynamic dependency.
 */

export class LineMap {
  private readonly starts: number[] = [0];

  constructor(text: string) {
    for (let index = 0; index < text.length; index += 1) {
      if (text[index] === "\n") this.starts.push(index + 1);
    }
  }

  line(index: number): number {
    let low = 0;
    let high = this.starts.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const start = this.starts[middle] ?? 0;
      const next = this.starts[middle + 1] ?? Number.POSITIVE_INFINITY;
      if (index < start) high = middle - 1;
      else if (index >= next) low = middle + 1;
      else return middle + 1;
    }
    return this.starts.length;
  }
}

function previousNonSpace(text: string, index: number): string | undefined {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (text[cursor] !== " " && text[cursor] !== "\t" && text[cursor] !== "\n" && text[cursor] !== "\r") {
      return text[cursor];
    }
  }
  return undefined;
}

function looksLikeRegexStart(text: string, index: number): boolean {
  const previous = previousNonSpace(text, index);
  if (previous === undefined) return true;
  if ("(,=:[!&|?{};+-*%<>~^".includes(previous)) return true;
  const before = text.slice(0, index).trimEnd();
  return /\b(return|case|typeof|delete|void|in|of|new|throw|else|do|instanceof|yield|await)$/.test(before);
}

function skipRegex(text: string, index: number): number {
  let cursor = index + 1;
  let inClass = false;
  while (cursor < text.length) {
    const char = text[cursor];
    if (char === "\\") {
      cursor += 2;
      continue;
    }
    if (char === "\n") return index;
    if (char === "[") inClass = true;
    else if (char === "]") inClass = false;
    else if (char === "/" && !inClass) return cursor + 1;
    cursor += 1;
  }
  return index;
}

/**
 * Replaces comments, regex literals, and string/template literal contents with
 * spaces while preserving length and newlines. Structural regexes run on this
 * mask so text inside a comment, message, or regex cannot look like code.
 */
export function maskCode(text: string): string {
  const output = [...text];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];
    if (char === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") output[index++] = " ";
      continue;
    }
    if (char === "/" && next === "*") {
      output[index++] = " ";
      output[index++] = " ";
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) {
        if (text[index] !== "\n") output[index] = " ";
        index += 1;
      }
      if (index < text.length) {
        output[index++] = " ";
        if (index < text.length) output[index++] = " ";
      }
      continue;
    }
    if (char === "/" && looksLikeRegexStart(text, index)) {
      const end = skipRegex(text, index);
      if (end !== index) {
        while (index < end) {
          if (text[index] !== "\n") output[index] = " ";
          index += 1;
        }
        continue;
      }
    }
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      output[index++] = " ";
      while (index < text.length) {
        const current = text[index];
        if (current === "\\") {
          output[index++] = " ";
          if (index < text.length) output[index++] = " ";
          continue;
        }
        if (current === quote) {
          output[index++] = " ";
          break;
        }
        if (current !== "\n") output[index] = " ";
        index += 1;
      }
      continue;
    }
    index += 1;
  }
  return output.join("");
}

function skipString(text: string, index: number): number {
  const quote = text[index];
  if (quote === undefined) return index;
  let cursor = index + 1;
  while (cursor < text.length) {
    const char = text[cursor];
    if (char === "\\") {
      cursor += 2;
      continue;
    }
    if (char === quote) return cursor + 1;
    cursor += 1;
  }
  return cursor;
}

function skipComment(text: string, index: number): number {
  if (text[index] === "/" && text[index + 1] === "/") {
    let cursor = index + 2;
    while (cursor < text.length && text[cursor] !== "\n") cursor += 1;
    return cursor;
  }
  if (text[index] === "/" && text[index + 1] === "*") {
    const end = text.indexOf("*/", index + 2);
    return end === -1 ? text.length : end + 2;
  }
  return index;
}

/** Returns the index just after the matching close character, or -1. */
export function findMatching(text: string, openIndex: number): number {
  const open = text[openIndex];
  const close =
    open === "{" ? "}" : open === "(" ? ")" : open === "[" ? "]" : undefined;
  if (close === undefined) return -1;
  let depth = 0;
  let index = openIndex;
  while (index < text.length) {
    const char = text[index];
    if (char === '"' || char === "'" || char === "`") {
      index = skipString(text, index);
      continue;
    }
    if (char === "/" && (text[index + 1] === "/" || text[index + 1] === "*")) {
      index = skipComment(text, index);
      continue;
    }
    if (char === "/" && looksLikeRegexStart(text, index)) {
      const end = skipRegex(text, index);
      if (end !== index) {
        index = end;
        continue;
      }
    }
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
    index += 1;
  }
  return -1;
}

/** Splits at a separator that is not nested inside brackets or literals. */
export function splitTopLevel(text: string, separator = ","): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '"' || char === "'" || char === "`") {
      index = skipString(text, index);
      continue;
    }
    if (char === "/" && (text[index + 1] === "/" || text[index + 1] === "*")) {
      index = skipComment(text, index);
      continue;
    }
    if (char === "/" && looksLikeRegexStart(text, index)) {
      const end = skipRegex(text, index);
      if (end !== index) {
        index = end;
        continue;
      }
    }
    if (char === "{" || char === "(" || char === "[") depth += 1;
    else if (char === "}" || char === ")" || char === "]") depth -= 1;
    else if (char === separator && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
    index += 1;
  }
  parts.push(text.slice(start));
  return parts;
}

function topLevelColon(text: string): number {
  let depth = 0;
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '"' || char === "'" || char === "`") {
      index = skipString(text, index);
      continue;
    }
    if (char === "/" && (text[index + 1] === "/" || text[index + 1] === "*")) {
      index = skipComment(text, index);
      continue;
    }
    if (char === "/" && looksLikeRegexStart(text, index)) {
      const end = skipRegex(text, index);
      if (end !== index) {
        index = end;
        continue;
      }
    }
    if (char === "{" || char === "(" || char === "[") depth += 1;
    else if (char === "}" || char === ")" || char === "]") depth -= 1;
    else if (char === ":" && depth === 0) return index;
    index += 1;
  }
  return -1;
}

function unquoteKey(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Parses the top-level `key: value` fields of an object literal. */
export function parseObjectFields(objectLiteral: string): Map<string, string> {
  const fields = new Map<string, string>();
  const trimmed = objectLiteral.trim();
  if (!trimmed.startsWith("{")) return fields;
  const close = findMatching(trimmed, 0);
  const inner = close === -1 ? trimmed.slice(1, -1) : trimmed.slice(1, close - 1);
  for (const part of splitTopLevel(inner, ",")) {
    const colon = topLevelColon(part);
    if (colon === -1) continue;
    const rawKey = part.slice(0, colon).trim();
    if (!rawKey || rawKey.startsWith("...")) continue;
    const key = unquoteKey(rawKey);
    if (!key || fields.has(key)) continue;
    fields.set(key, part.slice(colon + 1).trim());
  }
  return fields;
}

export function stringLiteral(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed.startsWith('"')) {
    let index = 1;
    while (index < trimmed.length) {
      if (trimmed[index] === "\\") {
        index += 2;
        continue;
      }
      if (trimmed[index] === '"') {
        try {
          return JSON.parse(trimmed.slice(0, index + 1)) as string;
        } catch {
          return null;
        }
      }
      index += 1;
    }
    return null;
  }
  if (trimmed.startsWith("'")) {
    let index = 1;
    let output = "";
    while (index < trimmed.length) {
      if (trimmed[index] === "\\") {
        output += trimmed[index + 1] ?? "";
        index += 2;
        continue;
      }
      if (trimmed[index] === "'") return output;
      output += trimmed[index];
      index += 1;
    }
    return null;
  }
  if (trimmed.startsWith("`") && trimmed.endsWith("`")) {
    const body = trimmed.slice(1, -1);
    return body.includes("${") ? null : body;
  }
  return null;
}

export function stringArray(value: string | undefined): string[] {
  if (value === undefined) return [];
  const trimmed = value.trim();
  if (!trimmed.startsWith("[")) return [];
  const close = findMatching(trimmed, 0);
  const inner = close === -1 ? trimmed.slice(1, -1) : trimmed.slice(1, close - 1);
  const values: string[] = [];
  for (const part of splitTopLevel(inner, ",")) {
    const literal = stringLiteral(part);
    if (literal !== null) values.push(literal);
  }
  return values;
}

export function objectKeys(value: string | undefined): string[] {
  if (value === undefined) return [];
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) return [];
  return [...parseObjectFields(trimmed).keys()];
}

export interface ImportSpec {
  readonly specifier: string;
  readonly names: readonly { readonly imported: string; readonly local: string }[];
  readonly index: number;
  readonly reexport: boolean;
}

function parseNamedList(raw: string): { imported: string; local: string }[] {
  const names: { imported: string; local: string }[] = [];
  for (const part of splitTopLevel(raw, ",")) {
    const trimmed = part.trim().replace(/^type\s+/, "");
    if (!trimmed) continue;
    const match = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(trimmed);
    if (match?.[1] === undefined) continue;
    names.push({ imported: match[1], local: match[2] ?? match[1] });
  }
  return names;
}

export function extractImports(text: string, masked: string): ImportSpec[] {
  const imports: ImportSpec[] = [];
  const seen = new Set<string>();
  const record = (specifier: string, names: ImportSpec["names"], index: number, reexport: boolean): void => {
    if (masked[index] === " ") return;
    const key = `${index}|${specifier}`;
    if (seen.has(key)) return;
    seen.add(key);
    imports.push({ specifier, names, index, reexport });
  };

  for (const match of text.matchAll(/\bimport\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g)) {
    const raw = match[1];
    const specifier = match[2];
    if (raw === undefined || specifier === undefined || match.index === undefined) continue;
    record(specifier, parseNamedList(raw), match.index, false);
  }
  for (const match of text.matchAll(/\bimport\s+\*\s+as\s+[A-Za-z_$][\w$]*\s+from\s+["']([^"']+)["']/g)) {
    const specifier = match[1];
    if (specifier === undefined || match.index === undefined) continue;
    record(specifier, [], match.index, false);
  }
  for (const match of text.matchAll(/\bimport\s+["']([^"']+)["']/g)) {
    const specifier = match[1];
    if (specifier === undefined || match.index === undefined) continue;
    record(specifier, [], match.index, false);
  }
  for (const match of text.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    const specifier = match[1];
    if (specifier === undefined || match.index === undefined) continue;
    record(specifier, [], match.index, false);
  }
  for (const match of text.matchAll(/\bexport\s+(?:type\s+)?(?:\{[^}]*\}|\*)\s+from\s+["']([^"']+)["']/g)) {
    const specifier = match[1];
    if (specifier === undefined || match.index === undefined) continue;
    record(specifier, [], match.index, true);
  }
  return imports;
}

export interface SymbolDecl {
  readonly name: string;
  readonly index: number;
  readonly exported: boolean;
}

export function extractSymbols(masked: string): SymbolDecl[] {
  const symbols: SymbolDecl[] = [];
  for (const match of masked.matchAll(/(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) {
    const name = match[1];
    if (name === undefined || match.index === undefined) continue;
    symbols.push({ name, index: match.index, exported: match[0].trimStart().startsWith("export") });
  }
  for (const match of masked.matchAll(/\bexport\s+const\s+([A-Za-z_$][\w$]*)\s*=/g)) {
    const name = match[1];
    if (name === undefined || match.index === undefined) continue;
    symbols.push({ name, index: match.index, exported: true });
  }
  for (const match of masked.matchAll(/\bexport\s+class\s+([A-Za-z_$][\w$]*)/g)) {
    const name = match[1];
    if (name === undefined || match.index === undefined) continue;
    symbols.push({ name, index: match.index, exported: true });
  }
  return symbols;
}

export function enclosingSymbol(
  symbols: readonly SymbolDecl[],
  index: number,
): SymbolDecl | undefined {
  // extractSymbols appends consts and classes after functions, so the list is
  // not index-sorted. Pick the closest declaration before the index, never the
  // previous array element.
  let found: SymbolDecl | undefined;
  for (const symbol of symbols) {
    if (symbol.index >= index) continue;
    if (found === undefined || symbol.index > found.index) found = symbol;
  }
  return found;
}

export interface RouteDecl {
  readonly method: string;
  readonly url: string;
  readonly index: number;
  readonly openIndex: number;
  readonly inner: string;
}

export function extractRoutes(text: string, masked: string): RouteDecl[] {
  const routes: RouteDecl[] = [];
  for (const match of text.matchAll(/\bapp\.(get|post|put|delete|patch)\(\s*["']([^"']+)["']/g)) {
    const method = match[1];
    const url = match[2];
    if (method === undefined || url === undefined || match.index === undefined) continue;
    if (masked[match.index] === " ") continue;
    const openIndex = text.indexOf("(", match.index);
    if (openIndex === -1) continue;
    const closeIndex = findMatching(text, openIndex);
    if (closeIndex === -1) continue;
    routes.push({
      method: method.toUpperCase(),
      url,
      index: match.index,
      openIndex,
      inner: text.slice(openIndex + 1, closeIndex - 1),
    });
  }
  return routes;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
