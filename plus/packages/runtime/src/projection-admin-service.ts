import { randomUUID } from "node:crypto";

import type { Database } from "@artflow-plus/db";
import { insertAudit } from "@artflow-plus/db";
import {
  DomainError,
  type ExecutionMode,
  requirePermission,
} from "@artflow-plus/domain";
import type { Kysely } from "kysely";

import { runtimeActor, type RuntimeDeps } from "./deps.js";
import { rebuildExecutionProjection, retryBlockedProjection } from "./outbox-relay.js";

const MODES: readonly ExecutionMode[] = ["test", "rehearsal", "formal"];

function requireMode(mode: string): ExecutionMode {
  if (!MODES.includes(mode as ExecutionMode)) {
    throw new DomainError("INVALID_INPUT", "mode must be test, rehearsal, or formal.");
  }
  return mode as ExecutionMode;
}

async function audit(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: { activityId: string; mode: ExecutionMode; action: "retry" | "rebuild"; detail: Record<string, unknown> },
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await insertAudit(trx, {
      commandId: `projection-${input.action}-${randomUUID()}`,
      activityId: input.activityId,
      capability: "engine",
      commandType: `projection.${input.action}`,
      actor: runtimeActor(deps),
      detail: { mode: input.mode, ...input.detail },
    });
  });
}

export async function retryProjection(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: { readonly activityId: string; readonly mode: string },
): Promise<{ readonly retried: boolean }> {
  requirePermission(runtimeActor(deps), "studio.manage");
  const mode = requireMode(input.mode);
  const retried = await retryBlockedProjection(db, input.activityId, mode);
  await audit(db, deps, { activityId: input.activityId, mode, action: "retry", detail: { retried } });
  return { retried };
}

export async function rebuildProjection(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  input: { readonly activityId: string; readonly mode: string },
): Promise<{ readonly lastSequence: number; readonly sessions: number }> {
  requirePermission(runtimeActor(deps), "studio.manage");
  const mode = requireMode(input.mode);
  const result = await rebuildExecutionProjection(db, input.activityId, mode);
  const sessions = Object.keys(result.state.sessions).length;
  await audit(db, deps, {
    activityId: input.activityId,
    mode,
    action: "rebuild",
    detail: { lastSequence: result.lastSequence, sessions },
  });
  return { lastSequence: result.lastSequence, sessions };
}
