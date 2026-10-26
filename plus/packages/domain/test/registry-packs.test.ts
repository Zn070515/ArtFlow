import { expect, it } from "vitest";

import {
  capabilityDefinitionHash,
  competitionCapability,
  compileActivityDefinitionPackage,
  createCapabilityRegistry,
  createEmptyCompetitionDefinition,
  defaultCapabilityRegistry,
  instantiateActivityPack,
  SINGER_COMPETITION_PACK,
} from "../src/index.js";
import type {
  CapabilityCompiler,
  CapabilityManifest,
  CapabilityRegistration,
  CapabilitySurface,
  RegistryIssue,
} from "../src/index.js";

function passthroughCompiler(capabilityKey: string): CapabilityCompiler {
  return {
    capabilityKey,
    compile: (definition) => ({
      ok: true,
      capabilityKey,
      contentHash: capabilityDefinitionHash(definition),
      artifact: definition.payload,
    }),
  };
}

function stubCapability(
  identity: string,
  options: {
    dependencies?: readonly string[];
    conflicts?: readonly string[];
    surfaces?: readonly CapabilitySurface[];
    scopes?: readonly string[];
  } = {},
): CapabilityRegistration {
  const manifest: CapabilityManifest = {
    identity,
    version: "1",
    dependencies: options.dependencies ?? [],
    conflicts: options.conflicts ?? [],
    definitionSchemaVersion: 1,
    commands: [`${identity}.configure`],
    queries: [`${identity}.describe`],
    events: [`${identity[0]?.toUpperCase() ?? "X"}${identity.slice(1)}Configured`],
    permissions: [`${identity}.manage`],
    surfaces: options.surfaces ?? ["studio"],
    ...(options.scopes === undefined ? {} : { scopes: options.scopes }),
  };
  return {
    manifest,
    compiler: passthroughCompiler(identity),
    emptyDefinition: () => ({ schemaVersion: 1, payload: { schemaVersion: 1 } }),
  };
}

const SINGER_CAPABILITIES: readonly CapabilityRegistration[] = [
  stubCapability("competition"),
  stubCapability("registration"),
  stubCapability("questionnaire"),
  stubCapability("materials"),
  stubCapability("evaluation", { dependencies: ["competition"] }),
  stubCapability("voting", { dependencies: ["competition"] }),
  stubCapability("publishing", { dependencies: ["competition"] }),
  stubCapability("archive"),
];

function singerRegistry() {
  const result = createCapabilityRegistry(SINGER_CAPABILITIES);
  if (!result.ok) {
    throw new Error(`registry rejected: ${JSON.stringify(result.issues)}`);
  }
  return result.registry;
}

function codes(issues: readonly RegistryIssue[]): readonly string[] {
  return issues.map((item) => item.code);
}

it("the competition capability ships a compilable empty definition", () => {
  const compiled = compileActivityDefinitionPackage(
    {
      schemaVersion: 1,
      manifest: { key: "pkg", title: "Package" },
      capabilities: { competition: createEmptyCompetitionDefinition() },
      bindings: [],
    },
    [competitionCapability.compiler],
  );
  expect(compiled.ok).toBe(true);
  if (!compiled.ok) return;
  expect(compiled.capabilities.competition?.capabilityKey).toBe("competition");
  expect(compiled.capabilities.competition?.artifact).toMatchObject({
    order: ["roster", "result"],
  });
});

it("a registry refuses a duplicate capability identity", () => {
  const result = createCapabilityRegistry([
    stubCapability("competition"),
    stubCapability("competition"),
  ]);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(codes(result.issues)).toContain("CAPABILITY_DUPLICATE");
});

it("a registry refuses manifest scopes the execution API can never send", () => {
  const result = createCapabilityRegistry([
    stubCapability("competition", { scopes: ["Stage"] }),
  ]);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(codes(result.issues)).toContain("CAPABILITY_SCOPE");
});

it("a registry refuses duplicate manifest scopes", () => {
  const result = createCapabilityRegistry([
    stubCapability("competition", { scopes: ["stage", "stage"] }),
  ]);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(codes(result.issues)).toContain("CAPABILITY_SCOPE");
});

it("a registry refuses a compiler that belongs to another capability", () => {
  const registration: CapabilityRegistration = {
    ...stubCapability("competition"),
    compiler: passthroughCompiler("voting"),
  };
  const result = createCapabilityRegistry([registration]);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(codes(result.issues)).toContain("CAPABILITY_COMPILER_MISMATCH");
});

it("a registry refuses an unknown dependency", () => {
  const result = createCapabilityRegistry([
    stubCapability("evaluation", { dependencies: ["competition"] }),
  ]);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(codes(result.issues)).toContain("CAPABILITY_DEPENDENCY_UNKNOWN");
});

it("a registry refuses a capability that both depends on and conflicts with another", () => {
  const result = createCapabilityRegistry([
    stubCapability("competition"),
    stubCapability("evaluation", {
      dependencies: ["competition"],
      conflicts: ["competition"],
    }),
  ]);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(codes(result.issues)).toContain("CAPABILITY_DEPENDENCY_CONFLICT");
});

it("composition expands dependencies transitively", () => {
  const registry = singerRegistry();
  const result = registry.validateComposition({ enable: ["evaluation"] });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.plan.enabledCapabilities).toEqual(["competition", "evaluation"]);
});

it("composition reports an unknown capability", () => {
  const registry = singerRegistry();
  const result = registry.validateComposition({ enable: ["competition", "scheduling"] });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(codes(result.issues)).toContain("CAPABILITY_UNKNOWN");
});

it("composition refuses a disabled dependency that is still required", () => {
  const registry = singerRegistry();
  const result = registry.validateComposition({
    enable: ["evaluation"],
    disable: ["competition"],
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(codes(result.issues)).toContain("CAPABILITY_DEPENDENCY_DISABLED");
  expect(result.issues[0]?.path).toBe("capabilities.competition");
});

it("composition reports mutually declared conflicts once", () => {
  const registry = singerRegistry();
  const a = stubCapability("voting", { conflicts: ["evaluation"] });
  const b = stubCapability("evaluation", { conflicts: ["voting"] });
  const result = createCapabilityRegistry([stubCapability("competition"), a, b]);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const composition = result.registry.validateComposition({
    enable: ["competition", "evaluation", "voting"],
  });
  expect(composition.ok).toBe(false);
  if (composition.ok) return;
  expect(codes(composition.issues).filter((code) => code === "CAPABILITY_CONFLICT")).toHaveLength(1);
});

it("composition merges declared scope conflicts", () => {
  const base = singerRegistry();
  const registry = createCapabilityRegistry([
    { ...stubCapability("stage"), scopeConflicts: { stage: ["judging"] } },
    { ...stubCapability("judging"), scopeConflicts: { judging: ["voting"] } },
  ]);
  expect(registry.ok).toBe(true);
  expect(base.list()).toHaveLength(8);
  if (!registry.ok) return;
  const composition = registry.registry.validateComposition({ enable: ["stage", "judging"] });
  expect(composition.ok).toBe(true);
  if (!composition.ok) return;
  expect(composition.plan.scopeConflicts).toEqual({
    judging: ["voting"],
    stage: ["judging"],
  });
});

it("a pack generates a compilable empty definition from its defaults", () => {
  const result = instantiateActivityPack(SINGER_COMPETITION_PACK, singerRegistry());
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.instantiation.enabledCapabilities).toEqual([
    "archive",
    "competition",
    "materials",
    "publishing",
    "questionnaire",
    "registration",
  ]);
  expect(Object.keys(result.instantiation.definition.capabilities).sort()).toEqual(
    result.instantiation.enabledCapabilities,
  );
  const compiled = compileActivityDefinitionPackage(
    result.instantiation.definition,
    singerRegistry().compilers,
  );
  expect(compiled.ok).toBe(true);
});

it("guided answers enable and disable pack capabilities", () => {
  const result = instantiateActivityPack(SINGER_COMPETITION_PACK, singerRegistry(), {
    answers: { "audience-voting": true, "collect-materials": false },
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.instantiation.enabledCapabilities).toContain("voting");
  expect(result.instantiation.enabledCapabilities).not.toContain("materials");
});

it("a pack refuses an unknown guided answer", () => {
  const result = instantiateActivityPack(SINGER_COMPETITION_PACK, singerRegistry(), {
    answers: { "not-a-question": true },
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(codes(result.issues)).toContain("PACK_ANSWER_UNKNOWN");
});

it("a pack diagnoses a disabled dependency instead of silently re-enabling it", () => {
  const result = instantiateActivityPack(SINGER_COMPETITION_PACK, singerRegistry(), {
    disable: ["competition"],
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(codes(result.issues)).toContain("CAPABILITY_DEPENDENCY_DISABLED");
});

it("the default registry exposes only implemented capabilities", () => {
  expect(defaultCapabilityRegistry.list().map((item) => item.manifest.identity)).toEqual([
    "competition",
    "materials",
    "publishing",
    "questionnaire",
    "registration",
    "ticketing",
    "voting",
  ]);
  const result = instantiateActivityPack(SINGER_COMPETITION_PACK, defaultCapabilityRegistry, {
    answers: { "publish-results": false, archive: false },
  });
  expect(result.ok).toBe(true);
});

it("allows browser voting without ticketing and rejects ticket voting without it", () => {
  const browser = compileActivityDefinitionPackage(
    {
      schemaVersion: 1,
      manifest: { key: "browser-vote", title: "Browser vote" },
      capabilities: {
        voting: {
          schemaVersion: 1,
          payload: {
            schemaVersion: 2,
            purpose: "popularity",
            selectionType: "single",
            maxSelections: 1,
            identityPolicy: "browser",
            scoringRule: { kind: "ballot_share_percent", scale: 100, decimals: 2 },
          },
        },
      },
      bindings: [],
    },
    [defaultCapabilityRegistry.get("voting")?.compiler ?? passthroughCompiler("voting")],
  );
  expect(browser.ok).toBe(true);

  const ticket = compileActivityDefinitionPackage(
    {
      schemaVersion: 1,
      manifest: { key: "ticket-vote", title: "Ticket vote" },
      capabilities: {
        voting: {
          schemaVersion: 1,
          payload: {
            schemaVersion: 2,
            purpose: "score_component",
            selectionType: "single",
            maxSelections: 1,
            identityPolicy: "ticket",
            scoringRule: { kind: "ballot_share_percent", scale: 100, decimals: 2 },
          },
        },
      },
      bindings: [],
    },
    [defaultCapabilityRegistry.get("voting")?.compiler ?? passthroughCompiler("voting")],
  );
  expect(ticket.ok).toBe(false);
  if (ticket.ok) return;
  expect(ticket.issues.map((issue) => issue.code)).toContain("CAPABILITY_TICKETING_REQUIRED");
});
