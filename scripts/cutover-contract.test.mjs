import assert from "node:assert/strict";
import test from "node:test";

import { missingCutoverCommandScopes } from "./cutover-contract.mjs";

test("does not require voting command ownership for activities without voting", () => {
  assert.deepEqual(
    missingCutoverCommandScopes(
      ["competition", "registration", "publishing"],
      {
        "competition.round.prepare": ["judging"],
        "publishing.result.release": ["publishing"],
      },
    ),
    [],
  );
});

test("requires command ownership for every enabled runtime capability", () => {
  assert.deepEqual(
    missingCutoverCommandScopes(
      ["competition", "voting", "publishing"],
      { "competition.round.prepare": ["judging"] },
    ),
    ["voting.ballot.submit", "publishing.result.release"],
  );
});
