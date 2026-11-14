function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read a capability payload from an opaque Definition Package. Unknown
 * capabilities and malformed packages return undefined instead of throwing so
 * the structured editor can fall back to the Expert JSON tab. */
export function readCapabilityPayload(pkg: unknown, key: string): unknown {
  if (!isRecord(pkg) || !isRecord(pkg.capabilities)) return undefined;
  const capability = pkg.capabilities[key];
  if (!isRecord(capability)) return undefined;
  return capability.payload;
}

/** Patch one capability payload and preserve everything the structured editors
 * do not understand: manifest, bindings, other capabilities, and future
 * top-level fields. The original package is never mutated. */
export function patchCapabilityPayload(pkg: unknown, key: string, payload: unknown): unknown {
  const base: Record<string, unknown> = isRecord(pkg)
    ? { ...pkg }
    : { schemaVersion: 1, capabilities: {} };
  const capabilities: Record<string, unknown> = isRecord(base.capabilities)
    ? { ...base.capabilities }
    : {};
  const current = capabilities[key];
  capabilities[key] = {
    ...(isRecord(current) ? current : { schemaVersion: 1 }),
    payload,
  };
  return { ...base, capabilities };
}
