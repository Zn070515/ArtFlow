import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Generate `src/types.ts` from the committed schema snapshot.
 *
 * Migrations are the source of truth. `schema:snapshot` turns them into a
 * machine-readable schema; this script projects that schema into the Kysely
 * `Database` interface. The overrides below are the only hand-maintained
 * exceptions, and each one exists because PostgreSQL's type alone cannot say
 * how the repository code reads or writes the column.
 */
const snapshotPath = fileURLToPath(new URL("../schema.snapshot.json", import.meta.url));
const typesPath = fileURLToPath(new URL("../src/types.ts", import.meta.url));

const overrides = {
  "activity.enabled_capabilities": "ColumnType<string[] | string, string, string>",
  "activity.judge_entry_open": "ColumnType<boolean, boolean | undefined, boolean | undefined>",
  "activity.judge_entry_version": "ColumnType<number, number | undefined, number | undefined>",
  "material.content_ready": "ColumnType<boolean, boolean | undefined, boolean>",
  "registration.supplement_keys": "ColumnType<unknown, string | undefined, string>",
  "stage_result.source": "ColumnType<unknown, string | null | undefined, string | null>",
  "stage_result.stale_at": "ColumnType<Date | null, Date | string | null | undefined, Date | string | null>",
  "task_item.due_at": "ColumnType<Date | null, Date | string | null | undefined, Date | string | null>",
  "outbox.occurred_at": "ColumnType<Date, Date | string, never>",
  "outbox.published_at": "ColumnType<Date | null, Date | null | undefined, Date | null>",
  "outbox.dead_lettered_at": "ColumnType<Date | null, Date | null | undefined, Date | null>",
  "local_account.roles": "ColumnType<string[] | string, string, string>",
  "local_account.permissions": "ColumnType<string[] | string, string, string>",
  "local_session.roles": "ColumnType<string[] | string, string, string>",
  "local_session.permissions": "ColumnType<string[] | string, string, string>",
  "execution_projection.last_sequence": "ColumnType<string, string | number, string | number>",
  "execution_projection.blocked_sequence": "ColumnType<string | null, string | number | null, string | number | null>",
  "live_state.last_sequence": "ColumnType<string, string | number, string | number>",
  "live_state.blocked_sequence": "ColumnType<string | null, string | number | null, string | number | null>",
};

const immutableTimestampNames = new Set(["created_at", "compiled_at", "released_at"]);

function rowInterface(table) {
  return `${table
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("")}Row`;
}

function isTimestamp(dataType) {
  return dataType.startsWith("timestamp") || dataType === "date";
}

function baseType(dataType) {
  if (isTimestamp(dataType)) return "Date";
  if (dataType === "boolean") return "boolean";
  if (dataType === "integer" || dataType === "smallint" || dataType === "real" || dataType === "double precision") {
    return "number";
  }
  // varchar, text, uuid, bigint, numeric and unknown types keep string so the
  // pg driver's default representation stays explicit.
  return "string";
}

function columnType(table, column) {
  const override = overrides[`${table.name}.${column.name}`];
  if (override !== undefined) return override;

  const type = baseType(column.dataType);
  const nullable = column.nullable;
  const hasDefault = column.default !== null || column.identity;
  const generatedIdentity = column.identity || (column.default ?? "").startsWith("nextval(");

  if (column.dataType === "jsonb" || column.dataType === "json") {
    return nullable
      ? "ColumnType<unknown | null, string | null, string | null>"
      : "ColumnType<unknown, string, string>";
  }

  if (column.dataType === "bigint") {
    if (generatedIdentity) return "Generated<string>";
    return nullable
      ? "ColumnType<string | null, string | number | null, string | number | null>"
      : "ColumnType<string, string | number, string | number>";
  }

  if (isTimestamp(column.dataType)) {
    const immutable = immutableTimestampNames.has(column.name);
    if (nullable) {
      return "ColumnType<Date | null, Date | string | null, Date | string | null>";
    }
    if (immutable) {
      return hasDefault
        ? "ColumnType<Date, Date | string | undefined, never>"
        : "ColumnType<Date, Date | string, never>";
    }
    return hasDefault
      ? "ColumnType<Date, Date | string | undefined, Date | string>"
      : "ColumnType<Date, Date | string, Date | string>";
  }

  if (column.dataType === "numeric" || column.dataType === "decimal") {
    if (nullable) return "ColumnType<string | null, string | null, string | null>";
    if (hasDefault) return "ColumnType<string, string | undefined, string>";
    return "ColumnType<string, string, string>";
  }

  if (nullable) return `${type} | null`;
  if (hasDefault) return `ColumnType<${type}, ${type} | undefined, ${type}>`;
  return type;
}

const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
const lines = [
  "/* eslint-disable */",
  "// Generated by packages/db/scripts/generate-types.mjs from schema.snapshot.json.",
  "// Do not edit by hand: run `pnpm -C plus --filter @artflow-plus/db run schema:snapshot`",
  "// then `pnpm -C plus --filter @artflow-plus/db run schema:types`.",
  "import type { ColumnType, Generated } from \"kysely\";",
  "",
  "// pg returns jsonb as an object, but a parameter must be sent as JSON text.",
  "",
];

for (const table of snapshot.tables) {
  lines.push(`export interface ${rowInterface(table.name)} {`);
  for (const column of table.columns) {
    lines.push(`  ${column.name}: ${columnType(table, column)};`);
  }
  lines.push("}", "");
}

lines.push("export interface Database {");
for (const table of snapshot.tables) {
  lines.push(`  ${table.name}: ${rowInterface(table.name)};`);
}
lines.push("}", "");

const rendered = lines.join("\n");
if (process.argv.includes("--check")) {
  // `core.autocrlf=true` (the documented Windows dev setup) checks this file out
  // with CRLF even though the generator writes LF, so compare normalized text.
  const current = readFileSync(typesPath, "utf8").replace(/\r\n/g, "\n");
  if (current !== rendered) {
    console.error(
      "src/types.ts is stale: run `pnpm -C plus --filter @artflow-plus/db run schema:snapshot` then `... run schema:types`.",
    );
    process.exit(1);
  }
  console.log("src/types.ts matches schema.snapshot.json.");
} else {
  writeFileSync(typesPath, rendered, "utf8");
  console.log(`Wrote ${snapshot.tables.length} table types to src/types.ts.`);
}
