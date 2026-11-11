/** The stage a publish action may write. An undeclared key, including a hardcoded vote_result, is never used. */
export function declaredStageKey(
  stages: readonly { readonly key: string }[],
  selected: string,
): string | null {
  if (stages.some((stage) => stage.key === selected)) return selected;
  return stages[0]?.key ?? null;
}
