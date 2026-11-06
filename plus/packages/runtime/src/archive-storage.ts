import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/;

export interface StoredArchiveFile {
  readonly key: string;
  readonly size: number;
  readonly sha256: string;
}

export interface ArchiveStorage {
  put(key: string, bytes: Uint8Array): Promise<StoredArchiveFile>;
  read(key: string): Promise<Uint8Array>;
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
    async read(key) {
      return await readFile(target(key));
    },
    async remove(key) {
      await rm(target(key), { force: true });
    },
  };
}
