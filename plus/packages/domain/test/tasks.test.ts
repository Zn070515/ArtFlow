import { expect, it } from "vitest";

import {
  compileActivityDefinitionPackage,
  compileTasksDefinition,
  createTasksDefinition,
  defaultCapabilityRegistry,
  REVIEW_AWARDS_PACK,
  SINGER_COMPETITION_PACK,
  STAGE_SHOW_PACK,
  VOTE_POLL_PACK,
  instantiateActivityPack,
} from "../src/index.js";
import type { CompiledTasksArtifact, TaskTemplate } from "../src/index.js";

const TEMPLATES: readonly TaskTemplate[] = [
  {
    key: "materials.audio",
    title: "确认音频材料",
    sourceCapability: "materials",
    sourceKey: "audio",
    required: true,
  },
  {
    key: "registration.review",
    title: "审核报名",
    sourceCapability: "registration",
    sourceKey: "review",
    required: true,
  },
];

it("rejects duplicate task template keys and empty source fields", () => {
  const result = compileTasksDefinition(
    createTasksDefinition([
      TEMPLATES[0]!,
      { ...TEMPLATES[0]!, title: "重复" },
      { ...TEMPLATES[1]!, sourceCapability: "", sourceKey: "" },
    ]),
  );

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.issues.map((issue) => issue.code)).toEqual(
    expect.arrayContaining(["DUPLICATE_KEY", "SOURCE_CAPABILITY_INVALID", "SOURCE_KEY_INVALID"]),
  );
});

it("rejects a task template whose source capability is not enabled", () => {
  const result = compileActivityDefinitionPackage(
    {
      schemaVersion: 1,
      manifest: { key: "tasks-only", title: "Tasks only" },
      capabilities: { tasks: createTasksDefinition(TEMPLATES) },
      bindings: [],
    },
    defaultCapabilityRegistry.compilers,
  );

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.issues.map((issue) => issue.code)).toContain(
    "CAPABILITY_SOURCE_CAPABILITY_DISABLED",
  );
});

it("returns a deterministic deeply frozen tasks artifact", () => {
  const first = compileTasksDefinition(createTasksDefinition(TEMPLATES));
  const second = compileTasksDefinition(createTasksDefinition([...TEMPLATES].reverse()));

  expect(first.ok).toBe(true);
  expect(second.ok).toBe(true);
  if (!first.ok || !second.ok) return;
  const firstArtifact = first.artifact as CompiledTasksArtifact;
  expect(first.contentHash).toBe(second.contentHash);
  expect(first.artifact).toEqual(second.artifact);
  expect(Object.isFrozen(firstArtifact)).toBe(true);
  expect(Object.isFrozen(firstArtifact.templates)).toBe(true);
  expect(Object.isFrozen(firstArtifact.templates[0])).toBe(true);
});

it("registers tasks as optional with ops and studio surfaces", () => {
  const registration = defaultCapabilityRegistry.get("tasks");

  expect(registration?.manifest).toMatchObject({
    identity: "tasks",
    version: "1.0.0",
    dependencies: [],
    surfaces: ["ops", "studio"],
    scopes: [],
  });
  expect(registration?.manifest.commands).toEqual([
    "tasks.sync",
    "tasks.assign",
    "tasks.start",
    "tasks.block",
    "tasks.complete",
    "tasks.reopen",
  ]);
  expect(registration?.manifest.queries).toEqual(["tasks.list", "readiness.summary"]);
  expect(registration?.manifest.events).toEqual(["tasks.changed"]);
  expect(registration?.manifest.permissions).toEqual(["tasks.manage"]);
  expect(registration?.manifest.dependencies).not.toContain("registration");
});

it("opt-in pack answers create only source-valid task templates", () => {
  for (const pack of [
    SINGER_COMPETITION_PACK,
    STAGE_SHOW_PACK,
    REVIEW_AWARDS_PACK,
    VOTE_POLL_PACK,
  ]) {
    const disabled = instantiateActivityPack(pack, defaultCapabilityRegistry);
    const enabled = instantiateActivityPack(pack, defaultCapabilityRegistry, {
      answers: { tasks: true },
    });

    expect(disabled.ok, pack.identity).toBe(true);
    expect(enabled.ok, pack.identity).toBe(true);
    if (!disabled.ok || !enabled.ok) continue;
    expect(disabled.instantiation.enabledCapabilities, pack.identity).not.toContain("tasks");
    expect(disabled.instantiation.definition.capabilities.tasks, pack.identity).toBeUndefined();
    expect(enabled.instantiation.enabledCapabilities, pack.identity).toContain("tasks");
    const definition = enabled.instantiation.definition.capabilities.tasks;
    expect(definition, pack.identity).toBeDefined();
    if (definition === undefined) continue;
    const templates = (definition.payload as { templates: readonly TaskTemplate[] }).templates;
    for (const template of templates) {
      expect(enabled.instantiation.enabledCapabilities, `${pack.identity}:${template.key}`).toContain(
        template.sourceCapability,
      );
    }
  }
});
