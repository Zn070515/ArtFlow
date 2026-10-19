import { expect, it } from "vitest";

import { hasPermission, requirePermission } from "../src/auth.js";
import type { ActorContext } from "../src/actor.js";

const staff: ActorContext = {
  actorId: "staff-1",
  actorType: "user",
  roles: ["staff"],
  permissions: ["registration.review"],
};

it("accepts an exact or wildcard permission and rejects a missing permission", () => {
  expect(hasPermission(staff, "registration.review")).toBe(true);
  expect(hasPermission(staff, "materials.review")).toBe(false);
  expect(() => requirePermission(staff, "registration.review")).not.toThrow();
  expect(() => requirePermission(staff, "materials.review")).toThrowError(
    "materials.review",
  );
});

it("accepts the global wildcard without inferring permissions from roles", () => {
  const actor: ActorContext = { ...staff, permissions: ["*"] };
  expect(hasPermission(actor, "materials.review")).toBe(true);
  expect(hasPermission({ ...staff, permissions: [] }, "staff")).toBe(false);
});
