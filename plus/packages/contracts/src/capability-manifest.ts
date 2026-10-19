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
    events: Type.Array(Type.String({ pattern: "^[A-Z][A-Za-z0-9]+$" })),
    permissions: Type.Array(Type.String({ minLength: 1 })),
    surfaces: Type.Array(CapabilitySurfaceSchema, { uniqueItems: true, minItems: 1 }),
  },
  { additionalProperties: false },
);

export type CapabilityManifest = Static<typeof CapabilityManifestSchema>;
export type CapabilitySurface = Static<typeof CapabilitySurfaceSchema>;
