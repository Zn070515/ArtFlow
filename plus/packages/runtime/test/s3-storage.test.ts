import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { S3Client } from "@aws-sdk/client-s3";

import { createS3ArchiveStorage, createS3MaterialStorage } from "../src/s3-storage.js";

function fakeS3(): S3Client {
  const objects = new Map<string, Buffer>();
  return {
    async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      const name = command.constructor.name;
      const key = String(command.input.Key ?? "");
      if (name === "PutObjectCommand") {
        const body = command.input.Body;
        const bytes = body instanceof Uint8Array
          ? Buffer.from(body)
          : await new Promise<Buffer>((resolve, reject) => {
              const chunks: Buffer[] = [];
              const stream = body as Readable;
              stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
              stream.on("error", reject);
              stream.on("end", () => resolve(Buffer.concat(chunks)));
            });
        objects.set(key, bytes);
        return {};
      }
      if (name === "HeadObjectCommand") {
        const value = objects.get(key);
        if (value === undefined) throw new Error("NoSuchKey");
        return { ContentLength: value.length };
      }
      if (name === "GetObjectCommand") {
        const value = objects.get(key);
        if (value === undefined) throw new Error("NoSuchKey");
        const range = typeof command.input.Range === "string" ? /^bytes=(\d+)-(\d+)$/.exec(command.input.Range) : null;
        const body = range === null
          ? value
          : value.subarray(Number(range[1]), Number(range[2]) + 1);
        return { Body: Readable.from(body), ContentLength: body.length };
      }
      if (name === "DeleteObjectCommand") {
        objects.delete(key);
        return {};
      }
      throw new Error(`Unexpected command ${name}`);
    },
  } as unknown as S3Client;
}

describe("S3 storage", () => {
  it("writes, stats, ranges and deletes material objects", async () => {
    const storage = createS3MaterialStorage({ client: fakeS3(), bucket: "bucket", prefix: "media" });
    await storage.put("private/act-1/blob-1", new TextEncoder().encode("abcdefghij"));
    expect(await storage.stat("private/act-1/blob-1")).toEqual({ size: 10 });
    expect(Buffer.from(await storage.read("private/act-1/blob-1")).toString()).toBe("abcdefghij");
    const ranged = await storage.readStream("private/act-1/blob-1", { start: 2, end: 5 });
    const chunks: Buffer[] = [];
    for await (const chunk of ranged.stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe("cdef");
    await storage.remove("private/act-1/blob-1");
    await expect(storage.stat("private/act-1/blob-1")).rejects.toThrow();
  });

  it("keeps archive keys restricted to the sealed package shape", async () => {
    const storage = createS3ArchiveStorage({ client: fakeS3(), bucket: "bucket", prefix: "archives" });
    const stored = await storage.put("act-1/v1.zip", new Uint8Array([1, 2, 3]));
    expect(stored).toMatchObject({ key: "act-1/v1.zip", size: 3 });
    await expect(storage.put("../evil/v1.zip", new Uint8Array([1]))).rejects.toThrow(/Unsafe archive key/);
  });
});
