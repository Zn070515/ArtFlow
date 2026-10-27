import { expect, it } from "vitest";

import {
  compileQuestionnaireDefinition,
  createCapabilityRegistry,
  createEmptyMaterialsDefinition,
  createEmptyQuestionnaireDefinition,
  createEmptyRegistrationDefinition,
  createRegistration,
  defaultCapabilityRegistry,
  finalizeRoster,
  instantiateActivityPack,
  reviewRegistration,
  saveRegistrationAnswer,
  SINGER_COMPETITION_PACK,
  submitRegistration,
} from "../src/index.js";
import type { CapabilityDefinition, RegistrationState } from "../src/index.js";

function questionnaireDefinition(): CapabilityDefinition {
  return {
    schemaVersion: 1,
    payload: {
      schemaVersion: 1,
      version: "v1",
      questions: [
        { key: "name", label: "姓名", type: "text", required: true },
        {
          key: "audio",
          label: "伴奏",
          type: "file",
          required: true,
          file: { slot: "audio", purpose: "accompaniment", accepts: [".mp3", ".wav"] },
        },
      ],
    },
  };
}

it("compiles a versioned questionnaire and derives stable file slots", () => {
  const result = compileQuestionnaireDefinition(questionnaireDefinition());

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.artifact).toMatchObject({
    version: "v1",
    fileSlots: [{ key: "audio", slot: "audio", purpose: "accompaniment" }],
  });
  expect(result.contentHash).toHaveLength(64);
});

it("rejects duplicate question keys and a file question without a slot", () => {
  const result = compileQuestionnaireDefinition({
    schemaVersion: 1,
    payload: {
      schemaVersion: 1,
      version: "v1",
      questions: [
        { key: "name", label: "姓名", type: "text" },
        { key: "name", label: "重复", type: "text" },
        { key: "audio", label: "伴奏", type: "file" },
      ],
    },
  });

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.issues.map((issue) => issue.code)).toEqual(
    expect.arrayContaining(["DUPLICATE_KEY", "FILE_SLOT_REQUIRED"]),
  );
});

it("keeps registration lifecycle transitions explicit", () => {
  let state: RegistrationState = createRegistration({
    id: "reg-1",
    activityId: "act-1",
    participantId: "student-1",
    questionnaireVersion: "v1",
    questionnaireHash: "hash-1",
  });
  state = saveRegistrationAnswer(state, 0, "name", "Alice");
  state = submitRegistration(state, 1);
  state = reviewRegistration(state, 2, "need_supplement", "audio is missing", "staff-1");
  state = saveRegistrationAnswer(state, 3, "audio", "file-1");
  state = submitRegistration(state, 4);
  state = reviewRegistration(state, 5, "approved", "ok", "staff-1");

  expect(state.status).toBe("approved");
  expect(state.revision).toBe(6);
  expect(() => submitRegistration(state, 5)).toThrowError(/changed since/);
});

it("represents a not-yet-final roster as unknown rather than zero", () => {
  const roster = finalizeRoster({ status: "unknown", revision: 0 }, 0, 0, "2026-10-19T10:00:00Z");
  expect(roster).toMatchObject({ status: "final", approvedCount: 0 });
});

it("default Singer Pack instantiates with all M4 capabilities", () => {
  const result = instantiateActivityPack(SINGER_COMPETITION_PACK, defaultCapabilityRegistry, {
    answers: { "publish-results": false, archive: false },
  });

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.instantiation.enabledCapabilities).toEqual([
    "competition",
    "grouping",
    "materials",
    "questionnaire",
    "registration",
  ]);
  expect(Object.keys(result.instantiation.definition.capabilities).sort()).toEqual(
    [...result.instantiation.enabledCapabilities].sort(),
  );
});

it("M4 empty definitions compile through a registry", () => {
  const result = createCapabilityRegistry(defaultCapabilityRegistry.list());
  expect(result.ok).toBe(true);
  expect(createEmptyQuestionnaireDefinition().schemaVersion).toBe(1);
  expect(createEmptyMaterialsDefinition().schemaVersion).toBe(1);
  expect(createEmptyRegistrationDefinition().schemaVersion).toBe(1);
});
