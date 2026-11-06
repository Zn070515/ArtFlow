/**
 * Who issued a command. The transport must derive this from the authenticated
 * session; it is never accepted from a request body. M3 has no login yet, so
 * the API uses an explicit system actor and tests inject a fixed actor.
 */
export type ActorType = "system" | "user" | "service";

export interface ActorContext {
  readonly actorId: string;
  readonly actorType: ActorType;
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
  /** Opaque reference to the authentication context (session/token id). */
  readonly authContext?: string;
}

export const SYSTEM_ACTOR: ActorContext = Object.freeze({
  actorId: "system",
  actorType: "system",
  roles: Object.freeze(["system"]),
  permissions: Object.freeze(["*"]),
});
