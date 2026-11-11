export function identityLabel(parts: {
  readonly name?: string;
  readonly studentId?: string;
  readonly song?: string;
  readonly fallback: string;
}): string {
  const visible = [parts.name, parts.studentId, parts.song]
    .map((part) => part?.trim() ?? "")
    .filter((part) => part !== "");
  return visible.length === 0 ? parts.fallback : visible.join(" · ");
}

export function liveContestantLabel(
  participants: readonly {
    readonly participantId: string;
    readonly name: string;
    readonly studentId: string;
    readonly song: string;
  }[],
  participantId: string,
): string {
  const match = participants.find((item) => item.participantId === participantId);
  return identityLabel({
    name: match?.name,
    studentId: match?.studentId,
    song: match?.song,
    fallback: participantId,
  });
}

export function answerIdentity(
  answers: Readonly<Record<string, unknown>>,
  fallback: string,
): string {
  const text = (key: string): string => {
    const value = answers[key];
    return typeof value === "string" ? value.trim() : "";
  };
  return identityLabel({
    name: text("name"),
    studentId: text("student_id"),
    song: text("song"),
    fallback,
  });
}
