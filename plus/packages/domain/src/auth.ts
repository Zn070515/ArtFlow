import { DomainError } from "./errors.js";
import type { ActorContext } from "./actor.js";

/**
 * Permission checks are deliberately literal. Roles are descriptive context;
 * the authenticated provider is responsible for deriving permissions from them.
 */
export function hasPermission(actor: ActorContext, permission: string): boolean {
  return actor.permissions.includes("*") || actor.permissions.includes(permission);
}

export function requirePermission(actor: ActorContext, permission: string): void {
  if (!hasPermission(actor, permission)) {
    throw new DomainError("FORBIDDEN", `Permission ${permission} is required.`);
  }
}

export function canActFor(actor: ActorContext, subjectId: string, permission: string): boolean {
  return actor.actorId === subjectId || hasPermission(actor, permission);
}
