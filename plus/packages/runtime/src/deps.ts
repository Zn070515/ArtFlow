import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { SYSTEM_ACTOR } from "@artflow-plus/domain";
import type { ActorContext } from "@artflow-plus/domain";

import { createLocalArchiveStorage, type ArchiveStorage } from "./archive-storage.js";
import { createLocalMaterialStorage, type MaterialStorage } from "./material-storage.js";
import { createSmtpMailerFromEnv, type Mailer } from "./mail-service.js";
import { createS3ArchiveStorage, createS3ClientFromEnv, createS3MaterialStorage } from "./s3-storage.js";

/** Injected clocks/ids keep tests deterministic without global state. */
export interface RuntimeDeps {
  readonly now: () => string;
  readonly newEventId: () => string;
  /** HMAC key for capability signatures; never persisted or returned. */
  readonly credentialSecret?: string;
  /**
   * The authenticated actor. M3 has no login; the API passes an explicit
   * system actor and tests inject a fixed one. Never read this from a body.
   */
  readonly actor?: ActorContext;
  /** Transport-injected HttpOnly judge session; never accepted from a body. */
  readonly judgeSessionToken?: string;
  /** Sealed archive package storage; tests inject a temp root. */
  readonly archiveStorage?: ArchiveStorage;
  /** Uploaded material bytes plus the read-only v1 media bridge. */
  readonly materialStorage?: MaterialStorage;
  /** Password-reset delivery; null when SMTP is not configured. */
  readonly mailer?: Mailer | null;
}

export function runtimeActor(deps: RuntimeDeps): ActorContext {
  return deps.actor ?? SYSTEM_ACTOR;
}


function storageFromEnv(): Pick<RuntimeDeps, "archiveStorage" | "materialStorage"> {
  if (process.env.ARTFLOW_PLUS_STORAGE_DRIVER === "s3") {
    const client = createS3ClientFromEnv();
    const bucket = process.env.ARTFLOW_PLUS_S3_BUCKET ?? "";
    return {
      archiveStorage: createS3ArchiveStorage({
        client,
        bucket,
        prefix: process.env.ARTFLOW_PLUS_S3_ARCHIVE_PREFIX ?? "archives",
      }),
      materialStorage: createS3MaterialStorage({
        client,
        bucket,
        prefix: process.env.ARTFLOW_PLUS_S3_MEDIA_PREFIX ?? "media",
      }),
    };
  }
  return {
    archiveStorage: createLocalArchiveStorage(
      process.env.ARTFLOW_PLUS_ARCHIVE_DIR ?? resolve(process.cwd(), "var/archives"),
    ),
    materialStorage: createLocalMaterialStorage({
      root: process.env.ARTFLOW_PLUS_MEDIA_DIR ?? resolve(process.cwd(), "var/media"),
    }),
  };
}

export function defaultRuntimeDeps(): RuntimeDeps {
  const isProduction = process.env.NODE_ENV === "production" || process.env.APP_ENV === "production";
  return {
    now: () => new Date().toISOString(),
    newEventId: () => randomUUID(),
    credentialSecret:
      process.env.ARTFLOW_PLUS_CREDENTIAL_SECRET ??
      (isProduction ? undefined : "artflow-plus-development-secret"),
    actor: SYSTEM_ACTOR,
    ...storageFromEnv(),
    mailer: createSmtpMailerFromEnv(),
  };
}
