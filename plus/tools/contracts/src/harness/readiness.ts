import type { ActivityPack, CapabilityDefinition } from "@artflow-plus/domain";

export interface ReadinessFinding {
  readonly pack: string;
  readonly code: string;
  readonly message: string;
}

interface QuestionnairePayload {
  readonly questions?: readonly { readonly type?: string }[];
}

function questionnairePayload(
  definition: CapabilityDefinition | undefined,
): QuestionnairePayload | undefined {
  if (definition === undefined) return undefined;
  if (typeof definition.payload !== "object" || definition.payload === null) return undefined;
  return definition.payload as QuestionnairePayload;
}

/**
 * Starter packs are a product path, not just a list of capabilities. These
 * diagnostics make the "feature was enabled, but its user path is missing"
 * class visible without failing a build before the product is fixed.
 */
export function checkPackReadiness(packs: readonly ActivityPack[]): ReadinessFinding[] {
  const findings: ReadinessFinding[] = [];
  for (const pack of packs) {
    const definitions = pack.definitions ?? {};
    const questionnaire = questionnairePayload(definitions.questionnaire);
    const hasFileQuestion =
      questionnaire?.questions?.some((question) => question.type === "file") ?? false;

    if (definitions.materials !== undefined && !hasFileQuestion) {
      findings.push({
        pack: pack.identity,
        code: "MATERIALS_WITHOUT_FILE_QUESTION",
        message:
          "The pack defines materials but its questionnaire has no file question; participants cannot upload the material.",
      });
    }

    const ticketingAvailable =
      definitions.ticketing !== undefined ||
      pack.questions.some((question) => question.capability === "ticketing" && question.default);
    if (definitions.competition !== undefined && !ticketingAvailable) {
      findings.push({
        pack: pack.identity,
        code: "JUDGING_WITHOUT_TICKETING",
        message:
          "The pack defines competition judging but neither defines ticketing nor enables it by default; the Live judge-entry link has no credential capability.",
      });
    }

    const enablesVoting = pack.questions.some((question) => question.capability === "voting");
    if (enablesVoting && definitions.voting === undefined) {
      findings.push({
        pack: pack.identity,
        code: "VOTING_IDENTITY_IMPLICIT",
        message:
          "The pack exposes a voting option but defines no voting artifact; the identity policy falls back to the empty definition.",
      });
    }
  }
  return findings;
}

export function formatReadiness(findings: readonly ReadinessFinding[]): string {
  if (findings.length === 0) return "Pack readiness: no findings.\n";
  return [
    `Pack readiness findings (${findings.length}):`,
    ...findings.map((finding) => `- [${finding.code}] ${finding.pack}: ${finding.message}`),
    "",
  ].join("\n");
}
