import { readFile, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import { receiveUpload, removeUpload } from "../src/http/upload.js";

describe("streaming upload receiver", () => {
  it("writes a bounded temporary file and reports its size", async () => {
    const upload = await receiveUpload(
      Readable.from([Buffer.alloc(5), Buffer.alloc(7)]),
      20,
    );
    try {
      expect(upload.size).toBe(12);
      expect((await stat(upload.path)).size).toBe(12);
      expect((await readFile(upload.path)).length).toBe(12);
    } finally {
      await removeUpload(upload);
    }
    await expect(stat(upload.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a stream that crosses the ceiling", async () => {
    await expect(receiveUpload(Readable.from([Buffer.alloc(11)]), 10)).rejects.toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
    });
  });
});
