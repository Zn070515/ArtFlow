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
  assert.equal(payload.stages[0].result_method.resolution, "pending");
  assert.equal(payload.stages[0].audience_weight.resolution, "pending");
  assert.equal(payload.stages[0].previous_weight.resolution, "pending");
});

test("new rounds keep all execution facts pending until the operator confirms them", () => {
  const payload = { schema_version: 1, stages: [], execution_refs: {} };
  const stage = planning.addStage(payload);
  const round = planning.addRound(stage, { format: "collaboration" });

  assert.equal(round.format, "collaboration");
  assert.equal(round.scoring_mode.resolution, "pending");
  assert.equal(round.judge_count.resolution, "pending");
  assert.equal(round.rubric.criteria.length, 0);
});

test("new rounds leave the performance format explicit when no choice was made", () => {
  const payload = { schema_version: 1, stages: [], execution_refs: {} };
  const stage = planning.addStage(payload);
  const round = planning.addRound(stage);

  assert.equal(round.format, "");
  assert.equal(round.minimum_judge_count.resolution, "confirmed");
  assert.equal(round.rubric.description.resolution, "confirmed");
  assert.equal(payload.stages[0].audience_source.resolution, "confirmed");
});

test("planning percentage summary preserves explicit percentage semantics", () => {
  assert.equal(
    planning.formatPercentageTotal(["30%", "60%", "10%"]).label,
    "30% + 60% + 10% = 100%",
  );
  assert.equal(planning.formatPercentageTotal(["0.5%"]).total, "0.5");
});

test("preview status follows the nested result instead of HTTP success", () => {
  const state = planning.previewState({
    ok: true,
    result: { can_apply: false, business_complete: true, binding_ready: false },
  });

  assert.equal(state.canApply, false);
  assert.match(state.message, /绑定/);
});

test("pending issue text is derived from the latest preview response", () => {
  assert.equal(
    planning.pendingIssueText([
      { message: "请补充评委数量。" },
      { code: "MISSING_RUBRIC" },
    ]),
    "请补充评委数量。\nMISSING_RUBRIC",
  );
});
