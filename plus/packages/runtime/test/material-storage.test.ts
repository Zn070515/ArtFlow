import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createLocalMaterialStorage } from "../src/material-storage.js";

describe("material storage", () => {
  it("stores new content and serves a read-only legacy file", async () => {
    const root = await mkdtemp(join(tmpdir(), "artflow-material-"));
    const legacyRoot = await mkdtemp(join(tmpdir(), "artflow-legacy-"));
    await mkdir(join(legacyRoot, "submissions"), { recursive: true });
    await writeFile(join(legacyRoot, "submissions", "song.mp3"), "legacy-bytes");
    const storage = createLocalMaterialStorage({ root, legacyRoot });

    await storage.put("private/act-1/blob-1", new TextEncoder().encode("new-bytes"));
    expect(new TextDecoder().decode(await storage.read("private/act-1/blob-1"))).toBe("new-bytes");
    expect(new TextDecoder().decode(await storage.read("legacy-file:submissions/song.mp3"))).toBe("legacy-bytes");

    await storage.remove("private/act-1/blob-1");
    await expect(storage.read("private/act-1/blob-1")).rejects.toThrow();
  });

  it("rejects traversal and a legacy key without a configured root", async () => {
    const root = await mkdtemp(join(tmpdir(), "artflow-material-"));
    const storage = createLocalMaterialStorage({ root });
    await expect(storage.put("private/../escape", new Uint8Array([1]))).rejects.toThrow();
    await expect(storage.read("legacy-file:some/file")).rejects.toThrow(/legacy media root/);
    await expect(storage.read("legacy:42")).rejects.toThrow(/no stored bytes/);
  });
});
