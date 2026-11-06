import { capabilityDefinitionHash } from "../compiler.js";
import type {
  CapabilityCompileResult,
  CapabilityCompiler,
  CapabilityDefinition,
  CompiledCapabilityPlan,
} from "../model.js";
import { deepFreeze } from "../model.js";
import type { CapabilityRegistration } from "../registry.js";

export interface CompiledArchiveArtifact {
  readonly version: 1;
  readonly schemaVersion: 1;
  readonly format: "zip-json-csv";
}

export interface ArchiveManifestArtifact {
  readonly name: string;
  readonly mediaType: string;
  readonly size: number;
  readonly sha256: string;
}

export interface ArchiveManifest {
  readonly schemaVersion: 1;
  readonly packageId: string;
  readonly activityId: string;
  readonly version: number;
  readonly sealedAt: string;
  readonly sealedBy: string;
  readonly format: "zip-json-csv";
  readonly artifacts: readonly ArchiveManifestArtifact[];
  readonly excludedFields: readonly string[];
  readonly counts: {
    readonly releases: number;
    readonly stageResults: number;
    readonly sessions: number;
    readonly events: number;
  };
}

export interface ArchiveReleaseRow {
  readonly release: string;
  readonly snapshotAvailable: boolean;
  readonly snapshotActivityTitle: string | null;
  readonly snapshotPublicTitle: string | null;
}

export interface ArchiveSummary {
  readonly activityPhase: "archived";
  readonly activityInfoTitle: string;
  readonly releaseRows: readonly ArchiveReleaseRow[];
  readonly excludedFields: readonly string[];
}

export function createEmptyArchiveDefinition(): CapabilityDefinition {
  return {
    schemaVersion: 1,
    payload: { version: 1, schemaVersion: 1, format: "zip-json-csv" },
  };
}

export function compileArchiveDefinition(
  definition: CapabilityDefinition,
): CapabilityCompileResult {
  const payload = definition.payload;
  const valid =
    definition.schemaVersion === 1 &&
    typeof payload === "object" &&
    payload !== null &&
    (payload as { version?: unknown }).version === 1 &&
    (payload as { schemaVersion?: unknown }).schemaVersion === 1 &&
    (payload as { format?: unknown }).format === "zip-json-csv";
  if (!valid) {
    return deepFreeze({
      ok: false,
      issues: [
        {
          code: "PAYLOAD_INVALID",
          message: "Only the zip-json-csv archive format is supported.",
          path: "payload.format",
        },
      ],
    });
  }
  const plan: CompiledCapabilityPlan = {
    ok: true,
    capabilityKey: "archive",
    contentHash: capabilityDefinitionHash(definition),
    artifact: deepFreeze<CompiledArchiveArtifact>({
      version: 1,
      schemaVersion: 1,
      format: "zip-json-csv",
    }),
  };
  return deepFreeze(plan);
}

export const archiveCompiler: CapabilityCompiler = {
  capabilityKey: "archive",
  compile: compileArchiveDefinition,
};

export const archiveCapability: CapabilityRegistration = deepFreeze({
  manifest: {
    identity: "archive",
    version: "1",
    dependencies: [],
    conflicts: [],
    definitionSchemaVersion: 1,
    commands: [
      "archive.activity.archive",
      "archive.activity.unarchive",
      "archive.package.read",
    ],
    queries: ["archive.state.read"],
    events: ["ArchivePackaged", "ActivityArchived", "ActivityUnarchived"],
    permissions: ["archive.manage"],
    surfaces: ["studio", "ops"],
  },
  compiler: archiveCompiler,
  emptyDefinition: createEmptyArchiveDefinition,
});
