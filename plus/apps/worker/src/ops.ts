import { closeDb, createDb } from "@artflow-plus/db";
import type { ExecutionMode } from "@artflow-plus/domain";
import {
  rebuildExecutionProjection,
  retryBlockedProjection,
} from "@artflow-plus/runtime";

const MODES: readonly ExecutionMode[] = ["test", "rehearsal", "formal"];

function usage(): never {
  console.error(
    [
      "Usage:",
      "  pnpm --filter @artflow-plus/worker ops retry   --activity <id> --mode <test|rehearsal|formal>",
      "  pnpm --filter @artflow-plus/worker ops rebuild --activity <id> --mode <test|rehearsal|formal>",
    ].join("\n"),
  );
  process.exit(2);
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const activityId = flag("activity");
  const mode = flag("mode") as ExecutionMode | undefined;
  if (
    command === undefined ||
    activityId === undefined ||
    mode === undefined ||
    !MODES.includes(mode)
  ) {
    usage();
  }
  const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
  if (connectionString === undefined || connectionString.trim() === "") {
    throw new Error("ARTFLOW_PLUS_DATABASE_URL is required.");
  }
  const schema = process.env.ARTFLOW_PLUS_DB_SCHEMA;

  const db = createDb({
    connectionString,
    ...(schema === undefined || schema === "" ? {} : { schema }),
  });
  try {
    if (command === "retry") {
      const retried = await retryBlockedProjection(db, activityId, mode);
      console.log(JSON.stringify({ activityId, mode, retried }));
      return;
    }
    if (command === "rebuild") {
      const result = await rebuildExecutionProjection(db, activityId, mode);
      console.log(
        JSON.stringify({
          activityId,
          mode,
          lastSequence: result.lastSequence,
          sessions: Object.keys(result.state.sessions).length,
        }),
      );
      return;
    }
    usage();
  } finally {
    await closeDb(db);
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
