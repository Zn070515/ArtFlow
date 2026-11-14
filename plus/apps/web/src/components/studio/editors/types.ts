export interface CapabilityEditorProps {
  readonly payload: unknown;
  readonly onChange: (next: unknown) => void;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function integer(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}

export function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

export function payloadRecord(payload: unknown): Record<string, unknown> {
  return isRecord(payload) ? { ...payload } : {};
}
