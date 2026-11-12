import { defaultCapabilityRegistry } from "@artflow-plus/domain";
import { describe, expect, it } from "vitest";

/** Capabilities with an executable contract adapter under harness/adapters. */
const COVERED = new Set<string>(["competition", "publishing", "registration", "ticketing"]);

/**
 * A capability with commands but no adapter must say why. Keep the reason
 * concrete; "not yet" is a valid entry only when it names the next step.
 */
const EXEMPT: Readonly<Record<string, string>> = {
  archive:
    "Operational package build/read; archive-service tests cover integrity and release gates. No editable aggregate lifecycle.",
  attendance:
    "Append-only check-in facts with undo; there is no terminal state or OCC revision to walk.",
  grouping:
    "Follow-up candidate: draft/freeze stage lifecycle. Current grouping tests cover membership and consumption rules.",
  materials:
    "File bytes belong to the registration aggregate; extension, read, and archive guards live in registration/ticket tests.",
  questionnaire:
    "Definition input compiled into a release; compiler and golden fixtures cover the shape. No runtime aggregate.",
  tasks:
    "Operational checklist with task ownership; no command lifecycle that the shared adapter can express.",
  voting:
    "Follow-up candidate: session open/close and ballot identity. Runtime voting and ticket tests cover the current edges.",
};

describe("contract adapter coverage", () => {
  const manifests = defaultCapabilityRegistry.list().map((registration) => registration.manifest);

  it("covers or explicitly exempts every capability with commands", () => {
    const missing = manifests
      .filter((manifest) => manifest.commands.length > 0)
      .filter((manifest) => !COVERED.has(manifest.identity) && EXEMPT[manifest.identity] === undefined)
      .map((manifest) => manifest.identity);
    expect(missing).toEqual([]);
  });

  it("does not list a stale covered or exempt capability", () => {
    const identities = new Set(manifests.map((manifest) => manifest.identity));
    for (const identity of [...COVERED, ...Object.keys(EXEMPT)]) {
      expect(identities.has(identity), `${identity} is no longer a registered capability`).toBe(true);
    }
  });

  it("gives every exemption a concrete reason", () => {
    for (const [identity, reason] of Object.entries(EXEMPT)) {
      expect(reason.length, `${identity} needs a concrete reason`).toBeGreaterThan(30);
    }
  });
});
