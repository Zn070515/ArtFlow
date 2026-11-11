/**
 * Turns an opaque Activity Definition Package into the facts an organizer
 * needs before creating the activity. It only reads documented payload keys
 * and omits anything it cannot interpret; the raw JSON stays available as an
 * advanced view.
 */
export interface DefinitionSummary {
  readonly capabilities: readonly string[];
  readonly registration: readonly string[];
  readonly rounds: readonly string[];
  readonly scoring: readonly string[];
  readonly materials: readonly string[];
  readonly publishing: readonly string[];
  readonly voting: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function payloadOf(definition: unknown, capability: string): Record<string, unknown> | null {
  if (!isRecord(definition)) return null;
  const capabilities = definition.capabilities;
  if (!isRecord(capabilities)) return null;
  const entry = capabilities[capability];
  if (!isRecord(entry) || !isRecord(entry.payload)) return null;
  return entry.payload;
}

function describeQuestion(question: unknown): string | null {
  if (!isRecord(question)) return null;
  const label = text(question.label);
  if (label === null) return null;
  const type = text(question.type) ?? "text";
  const required = question.required === true ? "必填" : "选填";
  if (type === "file") {
    const file = isRecord(question.file) ? question.file : {};
    const accepts = asArray(file.accepts).filter((value): value is string => typeof value === "string");
    const maxBytes = typeof file.maxBytes === "number" ? `≤ ${formatBytes(file.maxBytes)}` : null;
    const detail = [accepts.length > 0 ? accepts.join("/") : null, maxBytes].filter(Boolean).join("，");
    return `${label}（文件${detail ? `：${detail}` : ""}，${required}）`;
  }
  if (type === "notice") return `${label}（说明）`;
  return `${label}（${required}）`;
}

function describeRound(round: unknown): string | null {
  if (!isRecord(round)) return null;
  const key = text(round.key);
  if (key === null) return null;
  const judges = typeof round.judgeCount === "number" ? round.judgeCount : null;
  const minimum = typeof round.minimumJudges === "number" ? round.minimumJudges : null;
  const advance = typeof round.advanceCount === "number" ? round.advanceCount : null;
  const parts = [
    judges === null ? "评委数未声明" : `${judges} 位评委`,
    minimum === null ? null : `至少 ${minimum} 位有效`,
    advance === null ? null : `晋级 ${advance} 人`,
  ].filter((value): value is string => value !== null);
  return `${key}：${parts.join("，")}`;
}

function describeCriterion(criterion: unknown): string | null {
  if (!isRecord(criterion)) return null;
  const key = text(criterion.key);
  if (key === null) return null;
  const weight = typeof criterion.weight === "number" ? `权重 ${criterion.weight}` : null;
  const maximum = typeof criterion.maximum === "number" ? `满分 ${criterion.maximum}` : null;
  return [key, weight, maximum].filter((value): value is string => value !== null).join(" · ");
}

const SELECTION_LABELS: Readonly<Record<string, string>> = {
  single: "单选",
  multiple: "多选",
};

const IDENTITY_LABELS: Readonly<Record<string, string>> = {
  ticket: "票据身份",
  browser: "浏览器身份",
  participant: "账号身份",
};

export function summarizeDefinition(
  definition: unknown,
  enabledCapabilities: readonly string[],
): DefinitionSummary {
  const registration: string[] = [];
  const rounds: string[] = [];
  const scoring: string[] = [];
  const materials: string[] = [];
  const publishing: string[] = [];
  const voting: string[] = [];

  const registrationPayload = payloadOf(definition, "registration");
  const lifecycle = registrationPayload === null ? null : text(registrationPayload.lifecycle);
  if (lifecycle !== null) {
    registration.push(`报名生命周期：${lifecycle === "open" ? "开放" : lifecycle}`);
  }

  const questionnaire = payloadOf(definition, "questionnaire");
  const questions = questionnaire === null ? [] : asArray(questionnaire.questions);
  for (const question of questions) {
    const described = describeQuestion(question);
    if (described !== null) registration.push(described);
  }

  const materialsPayload = payloadOf(definition, "materials");
  if (materialsPayload !== null) {
    if (typeof materialsPayload.maxBytes === "number") {
      materials.push(`单个材料上限：${formatBytes(materialsPayload.maxBytes)}`);
    }
    const purposes = asArray(materialsPayload.allowedPurposes).filter(
      (value): value is string => typeof value === "string",
    );
    if (purposes.length > 0) materials.push(`允许的材料用途：${purposes.join("、")}`);
  }

  const competition = payloadOf(definition, "competition");
  if (competition !== null) {
    const scoringMethods = new Set<string>();
    for (const round of asArray(competition.rounds)) {
      const described = describeRound(round);
      if (described !== null) rounds.push(described);
      // Published packs declare the method per round, not at the top level.
      if (isRecord(round)) {
        const method = text(round.scoringMethod);
        if (method !== null) scoringMethods.add(method);
      }
    }
    if (scoringMethods.size === 0) {
      const scoringMethod = text(competition.scoringMethod);
      if (scoringMethod !== null) scoring.push(`计分方式：${scoringMethod}`);
    } else {
      scoring.push(`计分方式：${[...scoringMethods].join("、")}`);
    }
    const rubric = isRecord(competition.rubric) ? competition.rubric : null;
    const criteria = rubric === null ? [] : asArray(rubric.criteria);
    for (const criterion of criteria) {
      const described = describeCriterion(criterion);
      if (described !== null) scoring.push(described);
    }
    const tiePolicy = text(competition.tiePolicy);
    if (tiePolicy !== null) scoring.push(`并列处理：${tiePolicy}`);
  }

  const publishingPayload = payloadOf(definition, "publishing");
  if (publishingPayload !== null) {
    for (const stage of asArray(publishingPayload.stages)) {
      if (!isRecord(stage)) continue;
      const label = text(stage.label) ?? text(stage.key);
      if (label !== null) publishing.push(label);
    }
  }

  const votingPayload = payloadOf(definition, "voting");
  if (votingPayload !== null) {
    const selection = text(votingPayload.selectionType);
    const identity = text(votingPayload.identityPolicy);
    const maxSelections =
      typeof votingPayload.maxSelections === "number" ? votingPayload.maxSelections : null;
    const parts = [
      selection === null ? null : SELECTION_LABELS[selection] ?? selection,
      maxSelections === null ? null : `最多选 ${maxSelections} 项`,
      identity === null ? null : IDENTITY_LABELS[identity] ?? `身份策略 ${identity}`,
    ].filter((value): value is string => value !== null);
    if (parts.length > 0) voting.push(parts.join("，"));
  }

  return {
    capabilities: [...enabledCapabilities],
    registration,
    rounds,
    scoring,
    materials,
    publishing,
    voting,
  };
}
