import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { JOURNEY_ACTIONS, JourneySpecSchema } from "@artflow-plus/contracts";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

const journeysDirectory = fileURLToPath(new URL("../journeys", import.meta.url));

describe("journey specs", () => {
  const files = readdirSync(journeysDirectory).filter((name) => name.endsWith(".json"));

  it("contains at least one executable journey", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("declares only actions the runner implements", () => {
    const known = new Set<string>(JOURNEY_ACTIONS);
    for (const file of files) {
      const spec = JSON.parse(readFileSync(join(journeysDirectory, file), "utf8")) as {
        id?: unknown;
        steps?: { action?: unknown }[];
      };
      expect(Value.Check(JourneySpecSchema, spec), `${file} does not match the journey schema`).toBe(true);
      expect(spec.steps?.[0]?.action, `${file} must start by creating an activity`).toBe("create-activity");
      for (const step of spec.steps ?? []) {
        expect(known.has(String(step.action)), `${file} uses unknown action ${String(step.action)}`).toBe(true);
      }
    }
  });
});
