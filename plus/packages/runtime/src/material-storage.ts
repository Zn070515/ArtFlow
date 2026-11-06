import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

/** Any Unicode filename is allowed; only separators, NULs, and traversal are not. */
function safeSegment(segment: string): boolean {
  return segment !== "" && segment !== "." && segment !== ".." && !/[/\\\u0000-\u001f]/.test(segment);
}

export interface MaterialStorage {
  put(key: string, bytes: Uint8Array): Promise<void>;
  read(key: string): Promise<Uint8Array>;
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

/** Local material storage. Content lives under `private/<activity>/<blob>`. */
export function createLocalMaterialStorage(input: { readonly root: string }): MaterialStorage {
  const base = resolve(input.root);

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
      throw new Error("The material has no stored bytes.");
    },
    async remove(key) {
      if (key.startsWith("private/")) {
        await rm(inside(base, key.slice("private/".length)), { force: true });
        return;
      }
      throw new Error("The material has no stored bytes.");
    },
  };
}
