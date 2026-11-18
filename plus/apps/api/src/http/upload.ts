import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DomainError } from "@artflow-plus/domain";

export interface ReceivedUpload {
  readonly path: string;
  readonly size: number;
}

/**
 * Receives a raw upload into a temporary file. Memory stays bounded by the
 * stream's high-water mark even at the 600 MiB ceiling; the caller removes the
 * file after the command either adopts or rejects it.
 */
export async function receiveUpload(stream: Readable, maxBytes: number): Promise<ReceivedUpload> {
  const path = join(tmpdir(), `artflow-upload-${randomUUID()}`);
  let size = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > maxBytes) {
        callback(new DomainError(
          "PAYLOAD_TOO_LARGE",
          `The upload exceeds the ${maxBytes}-byte material ceiling.`,
        ));
        return;
      }
      callback(null, chunk);
    },
  });
  try {
    await pipeline(stream, counter, createWriteStream(path));
    return { path, size };
  } catch (error) {
    await rm(path, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function removeUpload(upload: ReceivedUpload): Promise<void> {
  await rm(upload.path, { force: true }).catch(() => undefined);
}
