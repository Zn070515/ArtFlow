import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const directory = path.join(plusRoot, ".artifacts");
mkdirSync(directory, { recursive: true });
const journalPath = path.join(directory, "mutation-journal.json");

function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

interface Journal {
  readonly file: string;
  readonly original: string;
}

/** A killed run must not leave the source tree mutated for the next build. */
function recoverInterruptedMutation(): void {
  if (!existsSync(journalPath)) return;
  let journal: Partial<Journal> = {};
  try {
    journal = JSON.parse(readFileSync(journalPath, "utf8")) as Partial<Journal>;
  } catch {
    // An unreadable journal cannot restore anything; remove it and continue.
  }
  if (typeof journal.file === "string" && typeof journal.original === "string") {
    writeFileSync(path.join(plusRoot, journal.file), journal.original, "utf8");
  }
  rmSync(journalPath, { force: true });
  throw new Error(
    "Recovered an interrupted mutation and restored the source file. Re-run the audit.",
  );
}

function runFocusedTest(mutation: Mutation): string {
  const args = [
    "--filter",
    mutation.package,
    "exec",
    "vitest",
    "run",
    mutation.testFile,
  ];
  if (mutation.testName !== undefined) args.push("-t", mutation.testName);
  return execSync(["pnpm", ...args].map(quote).join(" "), {
    cwd: plusRoot,
    env: {
      ...process.env,
      ARTFLOW_PLUS_DATABASE_URL: databaseUrl,
      REQUIRE_DB: "1",
      NO_COLOR: "1",
    },
    stdio: "pipe",
    timeout: 120_000,
  }).toString();
}

/**
 * The focused test must pass before the mutation. Otherwise a broken database,
 * a renamed test, or a missing dependency makes every mutation look CAUGHT.
 */
function requireFocusedTestPasses(mutation: Mutation, phase: string): void {
  let output: string;
  try {
    output = runFocusedTest(mutation);
  } catch {
    throw new Error(
      `Focused test ${mutation.testFile} (${mutation.testName ?? "all"}) failed ${phase}; refusing to record a mutation result. Fix the environment first.`,
    );
  }
  const passed = /Tests\s+(\d+) passed/.exec(output);
  if (passed === null || Number(passed[1]) < 1) {
    throw new Error(
      `Focused test ${mutation.testFile} (${mutation.testName ?? "all"}) ran zero tests ${phase}; the mutation would be meaningless.`,
    );
  }
}

recoverInterruptedMutation();

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

  requireFocusedTestPasses(mutation, "before mutation");
  writeFileSync(journalPath, `${JSON.stringify({ file: mutation.file, original })}\n`, "utf8");
  writeFileSync(file, mutated, "utf8");
  let caught = false;
  try {
    runFocusedTest(mutation);
  } catch {
    caught = true;
  } finally {
    writeFileSync(file, original, "utf8");
    rmSync(journalPath, { force: true });
  }
  if (caught) {
    // A failure that survives the restore is an environment problem, not a
    // killed mutation. Do not report it as coverage.
    requireFocusedTestPasses(mutation, "after the mutation was restored");
  }
  results.push({
    id: mutation.id,
    guarantee: mutation.guarantee,
    caught,
    skipped: false,
  });
}

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
