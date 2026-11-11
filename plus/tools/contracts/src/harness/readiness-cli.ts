import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  REVIEW_AWARDS_PACK,
  SINGER_COMPETITION_PACK,
  STAGE_SHOW_PACK,
} from "@artflow-plus/domain";

import { checkPackReadiness, formatReadiness } from "./readiness.js";

const root = path.resolve(import.meta.dirname, "../../../..");
const strict = process.argv.includes("--strict");
const packs = [SINGER_COMPETITION_PACK, STAGE_SHOW_PACK, REVIEW_AWARDS_PACK];
const findings = checkPackReadiness(packs);
const directory = path.join(root, ".artifacts");
mkdirSync(directory, { recursive: true });
const output = path.join(directory, "pack-readiness.json");
writeFileSync(
  output,
  `${JSON.stringify({ packs: packs.map((pack) => pack.identity), findings }, null, 2)}\n`,
  "utf8",
);
process.stdout.write(formatReadiness(findings));
process.stdout.write(`Report written to ${output}\n`);
if (strict && findings.length > 0) process.exitCode = 1;
