import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../../static/dist/ruleset_planning.js", import.meta.url), "utf8");
const context = { window: {}, document: { querySelector: () => null } };
vm.runInNewContext(source, context);
const planning = context.window.ArtFlowRulesetPlanning;

test("planning helpers add business stages without cloning technical DOM", () => {
  const payload = { schema_version: 1, stages: [], execution_refs: {} };

  planning.addStage(payload, { name: "初赛" });
  planning.addStage(payload, { name: "决赛" });

  assert.equal(payload.stages.length, 2);
  assert.notEqual(payload.stages[0].business_id, payload.stages[1].business_id);
  assert.equal(payload.stages[0].name.value, "初赛");
});

test("planning percentage summary preserves explicit percentage semantics", () => {
  assert.equal(
    planning.formatPercentageTotal(["30%", "60%", "10%"]).label,
    "30% + 60% + 10% = 100%",
  );
  assert.equal(planning.formatPercentageTotal(["0.5%"]).total, "0.5");
});
