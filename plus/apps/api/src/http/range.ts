export interface ByteRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Single-range parser for `Range: bytes=...`. Multiple ranges are rejected
 * (416) rather than silently collapsed; browsers only need the single case.
 */
export function parseRange(header: string | undefined, size: number): ByteRange | null | "invalid" {
  if (header === undefined || header.trim() === "") return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return "invalid";
  const startText = match[1] ?? "";
  const endText = match[2] ?? "";
  if (startText === "" && endText === "") return "invalid";
  if (size <= 0) return "invalid";
  let start: number;
  let end: number;
  if (startText === "") {
    const suffix = Number(endText);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startText);
    end = endText === "" ? size - 1 : Number(endText);
  }
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= size ||
    end < start
  ) {
    return "invalid";
  }
  return { start, end: Math.min(end, size - 1) };
}
