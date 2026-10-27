import type { Database, SessionRecord } from "@artflow-plus/db";
import {
  getActivitySummary,
  getCompiled,
  getDraft,
  listReleases,
} from "@artflow-plus/db";
import type { ActivityDefinitionPackage } from "@artflow-plus/domain";
import { DomainError, requirePermission } from "@artflow-plus/domain";
import type { Kysely } from "kysely";

import { runtimeActor, type RuntimeDeps } from "./deps.js";
import { listExecutions } from "./execution-service.js";

export interface StudioReleaseSummary {
  readonly version: number;
  readonly contentHash: string;
  readonly releasedAt: string;
  readonly sourceDraftRevision: number;
  readonly declaredScopes: readonly string[];
  readonly commandScopes: Readonly<Record<string, readonly string[]>>;
  readonly capabilityVersions: Readonly<Record<string, string>>;
  readonly active: boolean;
}

export interface StudioState {
  readonly activity: {
    readonly id: string;
    readonly publicCode: string;
    readonly title: string;
    readonly status: string;
    readonly revision: number;
    readonly enabledCapabilities: readonly string[];
    readonly activeDefinitionVersion: number;
  };
  readonly draft: {
    readonly revision: number;
    readonly package: ActivityDefinitionPackage;
  } | null;
  readonly compiled: {
    readonly draftRevision: number;
    readonly contentHash: string;
    readonly capabilities: readonly string[];
  } | null;
  readonly releases: readonly StudioReleaseSummary[];
  readonly sessions: readonly SessionRecord[];
}

export async function getStudioState(
  db: Kysely<Database>,
  deps: RuntimeDeps,
  activityId: string,
): Promise<StudioState> {
  requirePermission(runtimeActor(deps), "studio.manage");
  const activity = await getActivitySummary(db, activityId);
  if (activity === null) throw new DomainError("NOT_FOUND", "The activity was not found.");
  const draft = await getDraft(db, activityId);
  const compiled = draft === null ? null : await getCompiled(db, activityId, draft.revision);
  const releases = await listReleases(db, activityId);
  return {
    activity: {
      id: activity.id,
      publicCode: activity.publicCode,
      title: activity.title,
      status: activity.status,
      revision: activity.revision,
      enabledCapabilities: activity.enabledCapabilities,
      activeDefinitionVersion: activity.activeDefinitionVersion,
    },
    draft:
      draft === null
        ? null
        : { revision: draft.revision, package: draft.package },
    compiled:
      compiled === null
        ? null
        : {
            draftRevision: compiled.draftRevision,
            contentHash: compiled.contentHash,
            capabilities: Object.keys(compiled.capabilities).sort(),
          },
    releases: releases.map((release) => ({
      version: release.version,
      contentHash: release.contentHash,
      releasedAt: release.releasedAt,
      sourceDraftRevision: release.sourceDraftRevision,
      declaredScopes: release.executionPolicy.declaredScopes,
      commandScopes: release.executionPolicy.commandScopes ?? {},
      capabilityVersions: release.capabilityVersions,
      active: release.version === activity.activeDefinitionVersion,
    })),
    sessions: await listExecutions(db, activityId),
  };
}
