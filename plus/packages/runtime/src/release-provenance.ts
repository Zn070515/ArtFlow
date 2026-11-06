import { readFileSync } from "node:fs";

const FULL_RELEASE_SHA = /^[0-9a-f]{40}$/i;

export interface ReleaseProvenanceOptions {
  readonly releaseFile?: string;
  readonly env?: NodeJS.ProcessEnv;
}

function isProductionEnvironment(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === "production" || env.APP_ENV === "production";
}

function normalizeProductionSha(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!FULL_RELEASE_SHA.test(normalized)) {
    throw new Error(`${label} must be a 40-character Git commit SHA.`);
  }
  return normalized;
}

function bakedReleaseSha(releaseFile: string | undefined): string {
  if (releaseFile !== undefined) return releaseFile.trim();
  try {
    return readFileSync("/app/ARTFLOW_RELEASE_SHA", "utf8").trim();
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

/**
 * Prevents a production process from serving or consuming work with a host
 * configuration that does not belong to the image that was built.
 */
export function assertReleaseProvenance(options: ReleaseProvenanceOptions = {}): void {
  const env = options.env ?? process.env;
  const configured = env.ARTFLOW_RELEASE_SHA?.trim() ?? "";
  const baked = bakedReleaseSha(options.releaseFile);
  const production = isProductionEnvironment(env);

  if (!production && (configured === "" || baked === "")) return;
  if (configured === "") {
    throw new Error("ARTFLOW_RELEASE_SHA is required in production.");
  }
  if (baked === "") {
    throw new Error("The image is missing /app/ARTFLOW_RELEASE_SHA.");
  }
  const normalizedConfigured = production
    ? normalizeProductionSha(configured, "ARTFLOW_RELEASE_SHA")
    : configured;
  const normalizedBaked = production
    ? normalizeProductionSha(baked, "The image release marker")
    : baked;
  if (normalizedConfigured !== normalizedBaked) {
    throw new Error("ARTFLOW_RELEASE_SHA does not match the image release marker.");
  }
}
