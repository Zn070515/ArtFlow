import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

const SAFE_SEGMENT = /^[a-zA-Z0-9._-]+$/;

export interface MaterialStorage {
  put(key: string, bytes: Uint8Array): Promise<void>;
  read(key: string): Promise<Uint8Array>;
  remove(key: string): Promise<void>;
}

function safeRelativeSegments(relative: string): string[] {
  const segments = relative.split("/");
  if (
    segments.length === 0 ||
    segments.some((segment) => segment === "" || segment === "." || segment === ".." || !SAFE_SEGMENT.test(segment))
  ) {
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

/**
 * Local material storage. New content lives under `private/<activity>/<blob>`;
 * a read-only legacy root serves v1 files during operational adoption so staff
 * can still open the migrated accompaniment before media is re-uploaded.
 */
export function createLocalMaterialStorage(input: {
  readonly root: string;
  readonly legacyRoot?: string;
}): MaterialStorage {
  const base = resolve(input.root);
  const legacyBase = input.legacyRoot === undefined ? undefined : resolve(input.legacyRoot);

  async function write(key: string, bytes: Uint8Array): Promise<void> {
    if (!key.startsWith("private/")) throw new Error(`Unsafe material key: ${key}`);
    const path = inside(base, key.slice("private/".length));
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
    put: write,
    async read(key) {
      if (key.startsWith("private/")) {
        return await readFile(inside(base, key.slice("private/".length)));
      }
      if (key.startsWith("legacy-file:")) {
        if (legacyBase === undefined) {
          throw new Error("The legacy media root is not configured.");
        }
        return await readFile(inside(legacyBase, key.slice("legacy-file:".length)));
      }
      throw new Error("The material has no stored bytes.");
    },
    async remove(key) {
      if (key.startsWith("private/")) {
        await rm(inside(base, key.slice("private/".length)), { force: true });
        return;
      }
      throw new Error("Legacy material bytes are read-only.");
    },
  };
}
