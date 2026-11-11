import { randomInt } from "node:crypto";

/** Unambiguous aloud: no 0/O, 1/I/L, or U. Eight characters, grouped for speech. */
export const ACTIVITY_PUBLIC_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

export const ACTIVITY_PUBLIC_CODE_PATTERN = new RegExp(
  `^[${ACTIVITY_PUBLIC_CODE_ALPHABET}]{4}-[${ACTIVITY_PUBLIC_CODE_ALPHABET}]{4}$`,
);

const SPOKEN_ACTIVITY_PUBLIC_CODE = new RegExp(
  `^([${ACTIVITY_PUBLIC_CODE_ALPHABET}]{4})[-\\s]?([${ACTIVITY_PUBLIC_CODE_ALPHABET}]{4})$`,
  "i",
);

/**
 * Fold a spoken activity code to the stored form.
 * Values that are not that shape, including internal ids, stay unchanged.
 */
export function canonicalActivityPublicCode(value: string): string {
  const trimmed = value.trim();
  const match = SPOKEN_ACTIVITY_PUBLIC_CODE.exec(trimmed);
  const left = match?.[1];
  const right = match?.[2];
  if (left === undefined || right === undefined) return trimmed;
  return `${left.toUpperCase()}-${right.toUpperCase()}`;
}

export function createActivityPublicCode(
  nextIndex: (upperBound: number) => number = (upperBound) => randomInt(upperBound),
): string {
  let body = "";
  for (let index = 0; index < 8; index += 1) {
    const point = ACTIVITY_PUBLIC_CODE_ALPHABET[nextIndex(ACTIVITY_PUBLIC_CODE_ALPHABET.length)];
    if (point === undefined) {
      throw new Error("Activity public code alphabet index was out of range.");
    }
    body += point;
  }
  return `${body.slice(0, 4)}-${body.slice(4)}`;
}
