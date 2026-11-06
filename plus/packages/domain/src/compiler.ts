import { createHash } from "node:crypto";

import type {
  ActivityDefinitionPackage,
  CapabilityBinding,
  CapabilityCompiler,
  CapabilityDefinition,
  CompileIssue,
  CompiledActivityDefinition,
  CompiledCapabilityPlan,
  PackageCompileResult,
} from "./model.js";
import { deepFreeze } from "./model.js";

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Capability definitions must contain finite numbers.");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  throw new Error("Capability definitions must be JSON-serializable.");
}

function byBinding(left: CapabilityBinding, right: CapabilityBinding): number {
  const from = left.from < right.from ? -1 : left.from > right.from ? 1 : 0;
  if (from !== 0) return from;
  const to = left.to < right.to ? -1 : left.to > right.to ? 1 : 0;
  if (to !== 0) return to;
  return left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0;
}

function issue(code: string, message: string, path: string): CompileIssue {
  return { code, message, path };
}

/**
 * The Activity compiler hashes what the capability produced, without knowing
 * what it means. Capability order never changes the hash.
 */
export function capabilityDefinitionHash(definition: CapabilityDefinition): string {
  return createHash("sha256").update(canonicalJson(definition)).digest("hex");
}

export function canonicalActivityDefinitionPackage(pkg: ActivityDefinitionPackage): string {
  const capabilities = Object.keys(pkg.capabilities)
    .sort()
    .map((key) => {
      const definition = pkg.capabilities[key];
      return {
        key,
        hash: definition === undefined ? "" : capabilityDefinitionHash(definition),
      };
    });
  const bindings = [...(pkg.bindings ?? [])].sort(byBinding).map((binding) => ({
    from: binding.from,
    to: binding.to,
    kind: binding.kind,
  }));
  return JSON.stringify({
    schemaVersion: pkg.schemaVersion,
    manifest: { key: pkg.manifest.key, title: pkg.manifest.title },
    capabilities,
    bindings,
  });
}

export function activityDefinitionPackageHash(pkg: ActivityDefinitionPackage): string {
  return createHash("sha256").update(canonicalActivityDefinitionPackage(pkg)).digest("hex");
}

/**
 * The Activity compiler coordinates capability compilers and validates
 * cross-capability bindings. It never inspects a capability's internal nodes.
 */
export function compileActivityDefinitionPackage(
  pkg: ActivityDefinitionPackage,
  compilers: readonly CapabilityCompiler[],
): PackageCompileResult {
  const issues: CompileIssue[] = [];
  if (pkg.schemaVersion !== 1) {
    issues.push(issue("SCHEMA_VERSION", "Only schemaVersion 1 is supported.", "schemaVersion"));
  }
  if (!pkg.manifest.key.trim()) {
    issues.push(issue("MANIFEST_KEY", "The manifest needs a key.", "manifest.key"));
  }
  if (!pkg.manifest.title.trim()) {
    issues.push(issue("MANIFEST_TITLE", "The manifest needs a title.", "manifest.title"));
  }

  const capabilityKeys = Object.keys(pkg.capabilities);
  if (capabilityKeys.length === 0) {
    issues.push(
      issue("NO_CAPABILITIES", "An activity definition needs at least one capability.", "capabilities"),
    );
  }

  const registry = new Map<string, CapabilityCompiler>();
  for (const compiler of compilers) {
    registry.set(compiler.capabilityKey, compiler);
  }

  const compiled: Record<string, CompiledCapabilityPlan> = {};
  for (const key of capabilityKeys.sort()) {
    if (!key.trim()) {
      issues.push(issue("EMPTY_CAPABILITY_KEY", "A capability key cannot be empty.", "capabilities"));
      continue;
    }
    const definition = pkg.capabilities[key];
    if (definition === undefined) continue;
    const compiler = registry.get(key);
    if (compiler === undefined) {
      issues.push(
        issue(
          "CAPABILITY_COMPILER_MISSING",
          `No compiler is registered for capability ${key}.`,
          `capabilities.${key}`,
        ),
      );
      continue;
    }
    const result = compiler.compile(definition);
    if (!result.ok) {
      for (const item of result.issues) {
        issues.push(
          issue(
            `CAPABILITY_${item.code}`,
            `${key}: ${item.message}`,
            `capabilities.${key}.${item.path}`,
          ),
        );
      }
      continue;
    }
    if (result.capabilityKey !== key) {
      issues.push(
        issue(
          "CAPABILITY_KEY_MISMATCH",
          `Compiler for ${key} reported capabilityKey ${result.capabilityKey}.`,
          `capabilities.${key}`,
        ),
      );
      continue;
    }
    compiled[key] = result;
  }

  const bindingKeys = new Set<string>();
  for (const binding of pkg.bindings ?? []) {
    if (!capabilityKeys.includes(binding.from) || !capabilityKeys.includes(binding.to)) {
      issues.push(
        issue(
          "BINDING_UNKNOWN_CAPABILITY",
          `Binding ${binding.from} -> ${binding.to} names an unknown capability.`,
          "bindings",
        ),
      );
      continue;
    }
    if (!binding.kind.trim()) {
      issues.push(issue("BINDING_KIND", "A binding needs a kind.", "bindings"));
      continue;
    }
    const bindingKey = `${binding.from}->${binding.to}:${binding.kind}`;
    if (bindingKeys.has(bindingKey)) {
      issues.push(issue("DUPLICATE_BINDING", `Duplicate binding: ${bindingKey}.`, bindingKey));
      continue;
    }
    bindingKeys.add(bindingKey);
  }

  for (const key of capabilityKeys) {
    const compiler = registry.get(key);
    const plan = compiled[key];
    if (compiler?.validateComposition === undefined || plan === undefined) continue;
    for (const item of compiler.validateComposition({
      enabledCapabilities: capabilityKeys,
      artifact: plan.artifact,
    })) {
      issues.push(issue(`CAPABILITY_${item.code}`, `${key}: ${item.message}`, `capabilities.${key}.${item.path}`));
    }
  }

  if (issues.length > 0) {
    return deepFreeze({ ok: false, issues });
  }

  const result: CompiledActivityDefinition = {
    ok: true,
    contentHash: activityDefinitionPackageHash(pkg),
    capabilities: compiled,
  };
  return deepFreeze(result);
}
