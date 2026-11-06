import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createLocalMaterialStorage } from "../src/material-storage.js";

describe("material storage", () => {
  it("stores and removes new content", async () => {
    const root = await mkdtemp(join(tmpdir(), "artflow-material-"));
    const storage = createLocalMaterialStorage({ root });

    await storage.put("private/act-1/blob-1", new TextEncoder().encode("new-bytes"));
    expect(new TextDecoder().decode(await storage.read("private/act-1/blob-1"))).toBe("new-bytes");

    await storage.remove("private/act-1/blob-1");
    await expect(storage.read("private/act-1/blob-1")).rejects.toThrow();
  });

  it("rejects traversal and keys without stored bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "artflow-material-"));
    const storage = createLocalMaterialStorage({ root });
    await expect(storage.put("private/../escape", new Uint8Array([1]))).rejects.toThrow();
    await expect(storage.read("legacy:42")).rejects.toThrow(/no stored bytes/);
  });
});
