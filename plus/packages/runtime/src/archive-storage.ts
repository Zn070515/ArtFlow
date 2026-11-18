import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type { Readable } from "node:stream";

const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/;

export interface StoredArchiveFile {
  readonly key: string;
  readonly size: number;
  readonly sha256: string;
}

export interface ArchiveStream {
  readonly stream: Readable;
  readonly size: number;
}

export interface ArchiveStorage {
  put(key: string, bytes: Uint8Array): Promise<StoredArchiveFile>;
  putFile(key: string, sourcePath: string): Promise<StoredArchiveFile>;
  read(key: string): Promise<Uint8Array>;
  readStream(key: string, range?: { readonly start: number; readonly end: number }): Promise<ArchiveStream>;
  stat(key: string): Promise<{ readonly size: number }>;
  remove(key: string): Promise<void>;
}

function relativeKey(key: string): string {
  const segments = key.split("/");
  const activityId = segments[0];
  const file = segments[1];
  if (
    segments.length !== 2 ||
    activityId === undefined ||
    file === undefined ||
    !SAFE_SEGMENT.test(activityId) ||
    !/^v[0-9]+\.zip$/.test(file)
  ) {
    throw new Error(`Unsafe archive key: ${key}`);
  }
  return segments.join(sep);
}

/** Local-volume storage. Files live outside static/media and are only served by the controlled route. */
export function createLocalArchiveStorage(root: string): ArchiveStorage {
  const base = resolve(root);

  function target(key: string): string {
    const path = resolve(base, relativeKey(key));
    if (path !== base && !path.startsWith(`${base}${sep}`)) {
      throw new Error(`Archive key escapes the archive root: ${key}`);
    }
    return path;
  }

  return {
    async put(key, bytes) {
      const path = target(key);
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
      return {
        key,
        size: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    },
    async putFile(key, sourcePath) {
      const path = target(key);
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
        const hash = createHash("sha256");
        await new Promise<void>((resolveHash, rejectHash) => {
          const stream = createReadStream(temp);
          stream.on("data", (chunk: Buffer) => hash.update(chunk));
          stream.on("error", rejectHash);
          stream.on("end", () => resolveHash());
        });
        await rm(path, { force: true });
        await rename(temp, path);
        return { key, size: info.size, sha256: hash.digest("hex") };
      } catch (error) {
        await rm(temp, { force: true }).catch(() => undefined);
        throw error;
      }
    },
    async read(key) {
      return await readFile(target(key));
    },
    async readStream(key, range) {
      const path = target(key);
      const info = await stat(path);
      const stream = range === undefined
        ? createReadStream(path)
        : createReadStream(path, { start: range.start, end: range.end });
      return { stream, size: info.size };
    },
    async stat(key) {
      const info = await stat(target(key));
      return { size: info.size };
    },
    async remove(key) {
      await rm(target(key), { force: true });
    },
  };
}
