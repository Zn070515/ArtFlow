import { Type, type Static } from "@sinclair/typebox";

export const CapabilitySurfaceSchema = Type.Union([
  Type.Literal("studio"),
  Type.Literal("ops"),
  Type.Literal("live"),
  Type.Literal("portal"),
]);

/**
 * What a capability declares to the Engine and to the four product surfaces.
 * This is a contract, not a domain implementation: it says what exists, not
 * how it behaves.
 */
export const CapabilityManifestSchema = Type.Object(
  {
    identity: Type.String({ pattern: "^[a-z][a-z0-9_-]*$", maxLength: 80 }),
    version: Type.String({ minLength: 1, maxLength: 40 }),
    dependencies: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
    conflicts: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
    definitionSchemaVersion: Type.Integer({ minimum: 1 }),
    commands: Type.Array(Type.String({ pattern: "^[a-z][a-z0-9_.]*$" })),
    queries: Type.Array(Type.String({ pattern: "^[a-z][a-z0-9_.]*$" })),
    /**
     * Domain events are CamelCase (`RoundPrepared`). A capability may also
     * declare a dotted lowercase invalidation signal (`tasks.changed`) that it
     * emits through the same outbox. Both are part of the manifest contract.
     */
    events: Type.Array(
      Type.String({
        pattern: "^(?:[A-Z][A-Za-z0-9]+|[a-z][a-z0-9]*(?:\\.[a-z][a-z0-9]*)+)$",
      }),
    ),
    permissions: Type.Array(Type.String({ minLength: 1 })),
    surfaces: Type.Array(CapabilitySurfaceSchema, { uniqueItems: true, minItems: 1 }),
    scopes: Type.Optional(
      Type.Array(Type.String({ pattern: "^[a-z][a-z0-9_-]*$", maxLength: 100 }), {
        uniqueItems: true,
      }),
    ),
    /**
     * Execution-scoped commands owned by this capability and the scopes each
     * may run in. The domain registry freezes this map into the release; the
     * shared schema must describe the same field or the two declarations drift.
     */
    commandScopes: Type.Optional(
      Type.Record(
        Type.String({ pattern: "^[a-z][a-z0-9_.]*$" }),
        Type.Array(Type.String({ pattern: "^[a-z][a-z0-9_-]*$", maxLength: 100 }), {
          minItems: 1,
        }),
      ),
    ),
  },
  { additionalProperties: false },
);

export type CapabilityManifest = Static<typeof CapabilityManifestSchema>;
export type CapabilitySurface = Static<typeof CapabilitySurfaceSchema>;
