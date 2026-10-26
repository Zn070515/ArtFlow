import { readFile, writeFile } from "node:fs/promises";

import { closeDb, createDb, migrate } from "@artflow-plus/db";
import { defaultRuntimeDeps, importLegacyBundle, stableHash } from "@artflow-plus/runtime";
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
  throw new Error("Usage: import-legacy <bundle.json> [--dry-run] [--report <out.json>]");
}
const reportIndex = args.indexOf("--report");
const reportPath = reportIndex >= 0 ? args[reportIndex + 1] : undefined;

const db = createDb({
  connectionString,
  ...(schema === undefined ? {} : { schema }),
});
await migrate(db);

const bundle = JSON.parse(await readFile(bundlePath, "utf8")) as unknown;
const result = await importLegacyBundle(db, defaultRuntimeDeps(), {
  commandId: `legacy-import-${stableHash(bundle).slice(0, 32)}`,
  bundle,
  dryRun: args.includes("--dry-run"),
});
const report = JSON.stringify(result.report, null, 2);
if (reportPath !== undefined) await writeFile(reportPath, report, "utf8");
console.log(report);
await closeDb(db);
