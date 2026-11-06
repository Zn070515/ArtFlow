import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { closeDb, createDb, migrate } from "@artflow-plus/db";
import { defaultRuntimeDeps, importLegacyBundle } from "@artflow-plus/runtime";
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

const db = createDb({
  connectionString,
  ...(schema === undefined ? {} : { schema }),
});
await migrate(db);

const fixturePath = resolve(process.cwd(), "../../packages/runtime/test/fixtures/legacy-bundle.json");
const raw = JSON.parse(await readFile(fixturePath, "utf8")) as {
  activity: { publicCode: string };
  source: { publicCode: string };
};
const stamp = Date.now();
const publicCode = `LEG-${stamp}`;
const bundle = {
  ...raw,
  activity: { ...raw.activity, publicCode },
  source: { ...raw.source, publicCode },
};
await importLegacyBundle(db, defaultRuntimeDeps(), {
  commandId: `legacy-e2e-${stamp}`,
  bundle,
  dryRun: false,
});
const output = resolve(process.cwd(), "../../apps/web/.e2e-legacy.json");
await writeFile(output, JSON.stringify({ publicCode }, null, 2), "utf8");
await closeDb(db);
console.log(`Seeded legacy activity ${publicCode}`);
