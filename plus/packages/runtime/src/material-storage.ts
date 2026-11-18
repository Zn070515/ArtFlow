import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type { Readable } from "node:stream";

/** Any Unicode filename is allowed; only separators, NULs, and traversal are not. */
function safeSegment(segment: string): boolean {
  return segment !== "" && segment !== "." && segment !== ".." && !/[/\\\u0000-\u001f]/.test(segment);
}

export interface MaterialStream {
  readonly stream: Readable;
  readonly size: number;
}

export interface MaterialStorage {
  put(key: string, bytes: Uint8Array): Promise<void>;
  /** Atomically adopts a fully written temporary file without reading it into memory. */
  putFile(key: string, sourcePath: string): Promise<{ readonly size: number }>;
  read(key: string): Promise<Uint8Array>;
  /** `offset`/`length` implement HTTP Range without buffering the whole file. */
  readStream(key: string, range?: { readonly start: number; readonly end: number }): Promise<MaterialStream>;
  stat(key: string): Promise<{ readonly size: number }>;
  remove(key: string): Promise<void>;
}

function safeRelativeSegments(relative: string): string[] {
  const normalized = relative.normalize("NFC");
  const segments = normalized.split("/");
  if (segments.length === 0 || segments.some((segment) => !safeSegment(segment))) {
    throw new Error(`Unsafe material path: ${relative}`);
  }
  return segments;
}

function inside(base: string, relative: string): string {
  const path = resolve(base, ...safeRelativeSegments(relative));
  if (!path.startsWith(`${base}${sep}`)) {
    throw new Error(`Material path escapes its root: ${relative}`);
  }
  return path;
}

function requirePrivateKey(key: string): string {
  if (!key.startsWith("private/")) throw new Error(`Unsafe material key: ${key}`);
  return key.slice("private/".length);
}

/** Local material storage. Content lives under `private/<activity>/<blob>`. */
export function createLocalMaterialStorage(input: { readonly root: string }): MaterialStorage {
  const base = resolve(input.root);

  function pathFor(key: string): string {
    return inside(base, requirePrivateKey(key));
  }

  function readPathFor(key: string): string {
    if (!key.startsWith("private/")) {
      throw new Error("The material has no stored bytes.");
    }
    return inside(base, key.slice("private/".length));
  }

  async function writeFile(key: string, sourcePath: string): Promise<{ size: number }> {
    const path = pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      await copyFile(sourcePath, temp);
      const handle = await open(temp, "r+");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      const info = await stat(temp);
      await rm(path, { force: true });
      await rename(temp, path);
      return { size: info.size };
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async function writeBytes(key: string, bytes: Uint8Array): Promise<void> {
    const path = pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temp, "w");
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rm(path, { force: true });
      await rename(temp, path);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  return {
    put: writeBytes,
    async putFile(key, sourcePath) {
      return await writeFile(key, sourcePath);
    },
    async read(key) {
      return await readFile(readPathFor(key));
    },
    async readStream(key, range) {
      const path = readPathFor(key);
      const info = await stat(path);
      const stream = range === undefined
        ? createReadStream(path)
        : createReadStream(path, { start: range.start, end: range.end });
      return { stream, size: info.size };
    },
    async stat(key) {
      const info = await stat(readPathFor(key));
      return { size: info.size };
    },
    async remove(key) {
      if (!key.startsWith("private/")) {
        throw new Error("The material has no stored bytes.");
      }
      await rm(readPathFor(key), { force: true });
    },
  };
}
