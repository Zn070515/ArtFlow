import { capabilityDefinitionHash } from "../compiler.js";
import { fail } from "../errors.js";
import type {
  CapabilityCompileResult,
  CapabilityCompiler,
  CapabilityDefinition,
  CompileIssue,
  CompiledCapabilityPlan,
} from "../model.js";
import { deepFreeze } from "../model.js";
import type { CapabilityRegistration } from "../registry.js";

export type RegistrationStatus =
  | "draft"
  | "submitted"
  | "need_supplement"
  | "approved"
  | "rejected"
  | "withdrawn";

export interface RegistrationState {
  readonly id: string;
  readonly activityId: string;
  readonly participantId: string;
  readonly questionnaireVersion: string;
  readonly questionnaireHash: string;
  readonly status: RegistrationStatus;
  readonly answers: Readonly<Record<string, unknown>>;
  /** Slot keys staff explicitly opened for supplement in REVIEW/FINAL. */
  readonly supplementKeys?: readonly string[];
  readonly revision: number;
  readonly reviewNote?: string;
  readonly reviewedBy?: string;
}

export interface RosterUnknown {
  readonly status: "unknown";
  readonly revision: number;
}

export interface RosterFinal {
  readonly status: "final";
  readonly revision: number;
  readonly approvedCount: number;
  readonly finalizedAt: string;
}

export type RosterState = RosterUnknown | RosterFinal;

export type RegistrationLifecycle = "draft" | "open" | "review" | "final";

export interface RegistrationDefinition {
  readonly schemaVersion: 1;
  readonly lifecycleVersion: 1;
  /** The registration capability owns its own lifecycle, separate from Activity.status. */
  readonly lifecycle: RegistrationLifecycle;
}

export interface CompiledRegistrationArtifact {
  readonly schemaVersion: 1;
  readonly lifecycleVersion: 1;
  readonly lifecycle: RegistrationLifecycle;
  readonly rosterStatus: "unknown";
}

function issue(code: string, message: string, path: string): CompileIssue {
  return { code, message, path };
}

export function compileRegistrationDefinition(
  definition: CapabilityDefinition,
): CapabilityCompileResult {
  const payload = definition.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return deepFreeze({ ok: false, issues: [issue("PAYLOAD_INVALID", "Not a registration definition.", "payload")] });
  }
  const candidate = payload as Partial<RegistrationDefinition>;
  const issues: CompileIssue[] = [];
  if (candidate.schemaVersion !== 1) issues.push(issue("SCHEMA_VERSION", "Only schemaVersion 1 is supported.", "schemaVersion"));
  if (candidate.lifecycleVersion !== 1) issues.push(issue("LIFECYCLE_VERSION", "Only lifecycleVersion 1 is supported.", "lifecycleVersion"));
  if (issues.length > 0) return deepFreeze({ ok: false, issues });
  const artifact: CompiledRegistrationArtifact = {
    schemaVersion: 1,
    lifecycleVersion: 1,
    lifecycle: candidate.lifecycle ?? "open",
    rosterStatus: "unknown",
  };
  const plan: CompiledCapabilityPlan = {
    ok: true,
    capabilityKey: "registration",
    contentHash: capabilityDefinitionHash(definition),
    artifact: deepFreeze(artifact),
  };
  return deepFreeze(plan);
}

export const registrationCompiler: CapabilityCompiler = {
  capabilityKey: "registration",
  compile: compileRegistrationDefinition,
};

export function createRegistrationDefinition(
  lifecycle: RegistrationLifecycle = "open",
): CapabilityDefinition {
  return { schemaVersion: 1, payload: { schemaVersion: 1, lifecycleVersion: 1, lifecycle } };
}

export function createEmptyRegistrationDefinition(): CapabilityDefinition {
  return createRegistrationDefinition("open");
}

export function createRegistration(input: {
  readonly id: string;
  readonly activityId: string;
  readonly participantId: string;
  readonly questionnaireVersion: string;
  readonly questionnaireHash: string;
}): RegistrationState {
  if (!input.id.trim() || !input.activityId.trim() || !input.participantId.trim()) {
    fail("INVALID_INPUT", "Registration identity fields cannot be empty.");
  }
  return deepFreeze({
    ...input,
    status: "draft" as const,
    answers: {},
    revision: 0,
  });
}

function expectRevision(state: RegistrationState, expectedRevision: number): void {
  if (state.revision !== expectedRevision) fail("STALE_REVISION", "The registration changed since it was read.");
}

export function saveRegistrationAnswer(
  state: RegistrationState,
  expectedRevision: number,
  key: string,
  value: unknown,
): RegistrationState {
  expectRevision(state, expectedRevision);
  if (!key.trim()) fail("INVALID_INPUT", "Question key cannot be empty.");
  if (state.status !== "draft" && state.status !== "need_supplement") {
    fail("INVALID_TRANSITION", "Only a draft or supplement registration can be edited.");
  }
  return deepFreeze({
    ...state,
    answers: { ...state.answers, [key]: value },
    revision: state.revision + 1,
  });
}

export function submitRegistration(
  state: RegistrationState,
  expectedRevision: number,
): RegistrationState {
  expectRevision(state, expectedRevision);
  if (state.status !== "draft" && state.status !== "need_supplement") {
    fail("INVALID_TRANSITION", "Only a draft or supplement registration can be submitted.");
  }
  return deepFreeze({ ...state, status: "submitted" as const, revision: state.revision + 1 });
}

export function reviewRegistration(
  state: RegistrationState,
  expectedRevision: number,
  status: Extract<RegistrationStatus, "approved" | "need_supplement" | "rejected">,
  note: string,
  reviewerId: string,
): RegistrationState {
  expectRevision(state, expectedRevision);
  if (state.status !== "submitted") fail("INVALID_TRANSITION", "Only a submitted registration can be reviewed.");
  if (!reviewerId.trim()) fail("INVALID_INPUT", "A reviewer is required.");
  return deepFreeze({
    ...state,
    status,
    reviewNote: note.trim(),
    reviewedBy: reviewerId,
    revision: state.revision + 1,
  });
}

export function unknownRoster(revision = 0): RosterUnknown {
  return deepFreeze({ status: "unknown", revision });
}

export function finalizeRoster(
  state: RosterState,
  expectedRevision: number,
  approvedCount: number,
  finalizedAt: string,
): RosterFinal {
  if (state.revision !== expectedRevision) fail("STALE_REVISION", "The roster changed since it was read.");
  if (state.status !== "unknown") fail("INVALID_TRANSITION", "The roster is already final.");
  if (!Number.isInteger(approvedCount) || approvedCount < 0) fail("INVALID_INPUT", "approvedCount must be a non-negative integer.");
  if (!finalizedAt.trim()) fail("INVALID_INPUT", "finalizedAt is required.");
  return deepFreeze({ status: "final", revision: state.revision + 1, approvedCount, finalizedAt });
}

export function requireFinalRoster(state: RosterState): RosterFinal {
  if (state.status !== "final") fail("ROSTER_UNKNOWN", "The participant roster is not final.");
  return state;
}

export const registrationCapability: CapabilityRegistration = deepFreeze({
  manifest: {
    identity: "registration",
    version: "1",
    dependencies: ["materials", "questionnaire"],
    conflicts: [],
    definitionSchemaVersion: 1,
    commands: [
      "registration.start",
      "registration.answer",
      "registration.submit",
      "registration.review",
      "registration.roster.finalize",
      "registration.supplement.issue",
      "registration.supplement.submit",
    ],
    queries: ["registration.read", "registration.roster"],
    events: ["RegistrationStarted", "RegistrationSubmitted", "RegistrationReviewed", "RosterFinalized"],
    permissions: ["registration.manage", "registration.review", "registration.roster.finalize"],
    surfaces: ["studio", "ops", "portal", "live"],
    scopes: ["registration", "checkin"],
  },
  compiler: registrationCompiler,
  emptyDefinition: createEmptyRegistrationDefinition,
});
