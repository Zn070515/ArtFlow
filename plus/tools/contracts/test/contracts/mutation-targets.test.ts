import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { MUTATIONS } from "../../src/audit/mutations.js";

const plusRoot = path.resolve(import.meta.dirname, "../../../..");

describe("mutation audit targets", () => {
  for (const mutation of MUTATIONS) {
    it(`${mutation.id} still has a live target`, () => {
      const text = readFileSync(path.join(plusRoot, mutation.file), "utf8")
        .replace(/\r\n/g, "\n");
      expect(text, mutation.file).toContain(mutation.find);
      expect(text, `${mutation.id} replacement is already present`).not.toContain(mutation.replace);
    });
  }
});
