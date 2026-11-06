export function nextBackoff(
  attempt: number,
  random: () => number = Math.random,
  maxMs = 15000,
): number {
  const base = Math.min(500 * 2 ** Math.max(0, attempt), maxMs);
  const jitter = base * 0.2 * (random() * 2 - 1);
  return Math.max(100, Math.round(base + jitter));
}
