import type { CompileIssue, RegistryIssue } from "@artflow-plus/domain";

/** Composition diagnostics are a refusal, not a crash (422 at the edge). */
export class CompositionError extends Error {
  readonly code = "COMPOSITION_INVALID";

  constructor(readonly issues: readonly RegistryIssue[]) {
    super(
      `The capability composition is invalid: ${issues
        .map((issue) => `${issue.code} ${issue.path}`)
        .join(", ")}`,
    );
    this.name = "CompositionError";
  }
}

/** A draft that cannot compile never reaches release (422 at the edge). */
export class DefinitionInvalidError extends Error {
  readonly code = "DEFINITION_INVALID";

  constructor(readonly issues: readonly CompileIssue[]) {
    super(
      `The definition package is invalid: ${issues
        .map((issue) => `${issue.code} ${issue.path}`)
        .join(", ")}`,
    );
    this.name = "DefinitionInvalidError";
  }
}
