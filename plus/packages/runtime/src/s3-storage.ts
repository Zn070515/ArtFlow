import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { Readable } from "node:stream";
import { Transform } from "node:stream";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import type { ArchiveStorage, StoredArchiveFile } from "./archive-storage.js";
import type { MaterialStorage } from "./material-storage.js";

export interface S3StorageConfig {
  readonly client: S3Client;
  readonly bucket: string;
  readonly prefix: string;
}

function joinKey(prefix: string, key: string): string {
  const clean = prefix.replace(/^\/+|\/+$/g, "");
  return clean === "" ? key : `${clean}/${key}`;
}

function asReadable(body: unknown): Readable {
  return body as Readable;
}

function requirePrivateKey(key: string): string {
  if (!key.startsWith("private/")) throw new Error(`Unsafe material key: ${key}`);
  return key;
}

function requireArchiveKey(key: string): string {
  const segments = key.split("/");
  const activityId = segments[0];
  const file = segments[1];
  if (
    segments.length !== 2 ||
    activityId === undefined ||
    file === undefined ||
    !/^[A-Za-z0-9_-]+$/.test(activityId) ||
    !/^v[0-9]+\.zip$/.test(file)
  ) {
    throw new Error(`Unsafe archive key: ${key}`);
  }
  return key;
}

async function deleteObject(config: S3StorageConfig, key: string): Promise<void> {
  await config.client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: joinKey(config.prefix, key) }));
}

async function objectSize(config: S3StorageConfig, key: string): Promise<number> {
  const result = await config.client.send(
    new HeadObjectCommand({ Bucket: config.bucket, Key: joinKey(config.prefix, key) }),
  );
  return Number(result.ContentLength ?? 0);
}

async function readObject(
  config: S3StorageConfig,
  key: string,
  range?: { readonly start: number; readonly end: number },
): Promise<{ stream: Readable; size: number }> {
  const result = await config.client.send(new GetObjectCommand({
    Bucket: config.bucket,
    Key: joinKey(config.prefix, key),
    ...(range === undefined ? {} : { Range: `bytes=${range.start}-${range.end}` }),
  }));
  return {
    stream: asReadable(result.Body),
    size: Number(result.ContentLength ?? 0),
  };
}

async function putBytes(config: S3StorageConfig, key: string, bytes: Uint8Array): Promise<void> {
  await config.client.send(new PutObjectCommand({
    Bucket: config.bucket,
    Key: joinKey(config.prefix, key),
    Body: bytes,
  }));
}

export function createS3MaterialStorage(config: S3StorageConfig): MaterialStorage {
  return {
    async put(key, bytes) {
      await putBytes(config, requirePrivateKey(key), bytes);
    },
    async putFile(key, sourcePath) {
      const info = await stat(sourcePath);
      await config.client.send(new PutObjectCommand({
        Bucket: config.bucket,
        Key: joinKey(config.prefix, requirePrivateKey(key)),
        Body: createReadStream(sourcePath),
        ContentLength: info.size,
      }));
      return { size: info.size };
    },
    async read(key) {
      const { stream } = await readObject(config, requirePrivateKey(key));
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      return new Uint8Array(Buffer.concat(chunks));
    },
    async readStream(key, range) {
      return await readObject(config, requirePrivateKey(key), range);
    },
    async stat(key) {
      return { size: await objectSize(config, requirePrivateKey(key)) };
    },
    async remove(key) {
      await deleteObject(config, requirePrivateKey(key));
    },
  };
}

export function createS3ArchiveStorage(config: S3StorageConfig): ArchiveStorage {
  return {
    async put(key, bytes) {
      const valid = requireArchiveKey(key);
      await putBytes(config, valid, bytes);
      return {
        key: valid,
        size: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    },
    async putFile(key, sourcePath) {
      const valid = requireArchiveKey(key);
      const info = await stat(sourcePath);
      const hash = createHash("sha256");
      const tee = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      await config.client.send(new PutObjectCommand({
        Bucket: config.bucket,
        Key: joinKey(config.prefix, valid),
        Body: createReadStream(sourcePath).pipe(tee),
        ContentLength: info.size,
      }));
      return { key: valid, size: info.size, sha256: hash.digest("hex") } satisfies StoredArchiveFile;
    },
    async read(key) {
      const { stream } = await readObject(config, requireArchiveKey(key));
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      return new Uint8Array(Buffer.concat(chunks));
    },
    async readStream(key, range) {
      return await readObject(config, requireArchiveKey(key), range);
    },
    async stat(key) {
      return { size: await objectSize(config, requireArchiveKey(key)) };
    },
    async remove(key) {
      await deleteObject(config, requireArchiveKey(key));
    },
  };
}

export function createS3ClientFromEnv(env: NodeJS.ProcessEnv = process.env): S3Client {
  if (env.ARTFLOW_PLUS_S3_BUCKET === undefined || env.ARTFLOW_PLUS_S3_BUCKET.trim() === "") {
    throw new Error("ARTFLOW_PLUS_S3_BUCKET is required when the S3 storage driver is selected.");
  }
  return new S3Client({
    region: env.ARTFLOW_PLUS_S3_REGION ?? "us-east-1",
    ...(env.ARTFLOW_PLUS_S3_ENDPOINT === undefined || env.ARTFLOW_PLUS_S3_ENDPOINT === ""
      ? {}
      : { endpoint: env.ARTFLOW_PLUS_S3_ENDPOINT }),
    forcePathStyle: env.ARTFLOW_PLUS_S3_FORCE_PATH_STYLE === "1",
    ...(env.ARTFLOW_PLUS_S3_ACCESS_KEY_ID === undefined
      ? {}
      : {
          credentials: {
            accessKeyId: env.ARTFLOW_PLUS_S3_ACCESS_KEY_ID,
            secretAccessKey: env.ARTFLOW_PLUS_S3_SECRET_ACCESS_KEY ?? "",
          },
        }),
  });
}
