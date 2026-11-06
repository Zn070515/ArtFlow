import { readFile, writeFile } from "node:fs/promises";

import { closeDb, createDb, migrate } from "@artflow-plus/db";
import {
  defaultCapabilityRegistry,
  REVIEW_AWARDS_PACK,
  SINGER_COMPETITION_PACK,
  STAGE_SHOW_PACK,
  VOTE_POLL_PACK,
} from "@artflow-plus/domain";
import { adoptLegacyBundle, defaultRuntimeDeps, importLegacyBundle, stableHash } from "@artflow-plus/runtime";
import { Client } from "pg";

const connectionString = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (connectionString === undefined || connectionString.trim() === "") {
  throw new Error("ARTFLOW_PLUS_DATABASE_URL is required.");
}
const schema = process.env.ARTFLOW_PLUS_DB_SCHEMA;
if (schema !== undefined && !/^[a-z_][a-z0-9_]*$/.test(schema)) {
  throw new Error(`Unsafe ARTFLOW_PLUS_DB_SCHEMA: ${schema}`);
}
if (schema !== undefined) {
  const admin = new Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  await admin.end();
}

const args = process.argv.slice(2);
const bundlePath = args.find((arg) => !arg.startsWith("--"));
if (bundlePath === undefined) {
  throw new Error(
    "Usage: import-legacy <bundle.json> [--dry-run] [--report <out.json>] [--mode historical|adoption] [--pack <packId>] [--enable a,b] [--disable c]",
  );
}
const valueOf = (flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const reportPath = valueOf("--report");
const listOf = (flag: string): readonly string[] | undefined => {
  const value = valueOf(flag);
  return value === undefined ? undefined : value.split(",").map((item) => item.trim()).filter(Boolean);
};
const enable = listOf("--enable");
const disable = listOf("--disable");
const mode = valueOf("--mode") ?? "historical";
if (mode !== "historical" && mode !== "adoption") {
  throw new Error(`Unknown mode: ${mode}`);
}
const packId = valueOf("--pack");
const PACKS = [SINGER_COMPETITION_PACK, STAGE_SHOW_PACK, REVIEW_AWARDS_PACK, VOTE_POLL_PACK];
const pack = packId === undefined ? undefined : PACKS.find((candidate) => candidate.identity === packId);
if (mode === "adoption" && pack === undefined) {
  throw new Error(
    `Adoption needs --pack <${PACKS.map((candidate) => candidate.identity).join("|")}>.`,
  );
}

const db = createDb({
  connectionString,
  ...(schema === undefined ? {} : { schema }),
});
await migrate(db);

const bundle = JSON.parse(await readFile(bundlePath, "utf8")) as unknown;
const commandId = `legacy-${mode}-${stableHash(bundle).slice(0, 32)}`;
const result = mode === "adoption"
  ? await adoptLegacyBundle(db, defaultRuntimeDeps(), {
      commandId,
      bundle,
      dryRun: args.includes("--dry-run"),
      registry: defaultCapabilityRegistry,
      pack: pack!,
      ...(enable === undefined ? {} : { enable }),
      ...(disable === undefined ? {} : { disable }),
    })
  : await importLegacyBundle(db, defaultRuntimeDeps(), {
      commandId,
      bundle,
      dryRun: args.includes("--dry-run"),
    });
const report = JSON.stringify(result.report, null, 2);
if (reportPath !== undefined) await writeFile(reportPath, report, "utf8");
console.log(report);
await closeDb(db);
