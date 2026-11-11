import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { MUTATIONS } from "./mutations.js";
import type { Mutation } from "./mutations.js";

interface MutationResult {
  readonly id: string;
  readonly guarantee: string;
  readonly caught: boolean;
  readonly skipped: boolean;
}

const plusRoot = path.resolve(import.meta.dirname, "../../../..");
const repoRoot = path.dirname(plusRoot);
const strict = process.argv.includes("--strict");
const databaseUrl = process.env.ARTFLOW_PLUS_DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.trim() === "") {
  throw new Error("ARTFLOW_PLUS_DATABASE_URL is required for the mutation audit.");
}

function quote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function runFocusedTest(mutation: Mutation): void {
  const args = [
    "--filter",
    mutation.package,
    "exec",
    "vitest",
    "run",
    mutation.testFile,
  ];
  if (mutation.testName !== undefined) args.push("-t", mutation.testName);
  execSync(["pnpm", ...args].map(quote).join(" "), {
    cwd: plusRoot,
    env: {
      ...process.env,
      ARTFLOW_PLUS_DATABASE_URL: databaseUrl,
      REQUIRE_DB: "1",
    },
    stdio: "pipe",
    timeout: 120_000,
  });
}

const results: MutationResult[] = [];
for (const mutation of MUTATIONS) {
  const relative = path.join("plus", mutation.file);
  const status = execSync(`git status --porcelain -- ${quote(relative)}`, {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (status.trim() !== "") {
    throw new Error(`${mutation.file} has uncommitted changes; refusing to mutate it.`);
  }

  const file = path.join(plusRoot, mutation.file);
  const original = readFileSync(file, "utf8");
  const normalized = original.replace(/\r\n/g, "\n");
  if (!normalized.includes(mutation.find)) {
    results.push({
      id: mutation.id,
      guarantee: mutation.guarantee,
      caught: false,
      skipped: true,
    });
    continue;
  }

  const mutated = mutation.replaceAll === true
    ? normalized.split(mutation.find).join(mutation.replace)
    : normalized.replace(mutation.find, mutation.replace);
  writeFileSync(file, mutated, "utf8");
  let caught = false;
  try {
    runFocusedTest(mutation);
  } catch {
    caught = true;
  } finally {
    writeFileSync(file, original, "utf8");
  }
  results.push({
    id: mutation.id,
    guarantee: mutation.guarantee,
    caught,
    skipped: false,
  });
}

const directory = path.join(plusRoot, ".artifacts");
mkdirSync(directory, { recursive: true });
const output = path.join(directory, "mutation-audit.json");
writeFileSync(output, `${JSON.stringify({ results }, null, 2)}\n`, "utf8");

process.stdout.write("Mutation audit:\n");
for (const result of results) {
  const status = result.skipped ? "SKIPPED" : result.caught ? "CAUGHT" : "SURVIVED";
  process.stdout.write(`${status.padEnd(9)} ${result.id} — ${result.guarantee}\n`);
}
const survivors = results.filter((result) => !result.caught && !result.skipped);
const skipped = results.filter((result) => result.skipped);
process.stdout.write(`\n${results.length - survivors.length - skipped.length}/${results.length} caught; ${survivors.length} survived; ${skipped.length} skipped.\n`);
process.stdout.write(`Report written to ${output}\n`);
if (strict && (survivors.length > 0 || skipped.length > 0)) {
  process.exitCode = 1;
}
