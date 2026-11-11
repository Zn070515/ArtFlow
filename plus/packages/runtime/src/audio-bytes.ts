/**
 * Audio slots must match a container the released questionnaire accepts.
 * An extension alone is not evidence that the bytes are audio.
 */

const AUDIO_EXTENSIONS = new Set([
  ".aac",
  ".aif",
  ".aiff",
  ".flac",
  ".m4a",
  ".mp3",
  ".oga",
  ".ogg",
  ".wav",
  ".wave",
]);

export function slotAcceptsAudio(slot: {
  readonly purpose: string;
  readonly accepts: readonly string[];
}): boolean {
  if (slot.purpose.trim().toLowerCase() === "audio") return true;
  return slot.accepts.some((extension) => AUDIO_EXTENSIONS.has(normalizeExtension(extension)));
}

export function audioBytesMatchSlot(
  accepts: readonly string[],
  bytes: Uint8Array,
): boolean {
  const allowed = new Set(accepts.map(normalizeExtension));
  return CHECKS.some((check) =>
    check.extensions.some((extension) => allowed.has(extension)) && check.matches(bytes),
  );
}

function normalizeExtension(extension: string): string {
  const trimmed = extension.trim().toLowerCase();
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

function ascii(bytes: Uint8Array, offset: number, text: string): boolean {
  if (bytes.length < offset + text.length) return false;
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[offset + index] !== text.charCodeAt(index)) return false;
  }
  return true;
}

function looksLikeMp3(bytes: Uint8Array): boolean {
  if (bytes.length >= 10 && ascii(bytes, 0, "ID3")) {
    const major = bytes[3] ?? 0xff;
    const revision = bytes[4] ?? 0xff;
    return major !== 0xff && revision !== 0xff;
  }
  if (bytes.length < 4) return false;
  const first = bytes[0] ?? 0;
  const second = bytes[1] ?? 0;
  const third = bytes[2] ?? 0;
  if (first !== 0xff || (second & 0xe0) !== 0xe0) return false;
  const version = (second >> 3) & 0x03;
  const layer = (second >> 1) & 0x03;
  if (version === 1 || layer === 0) return false;
  const bitrate = (third >> 4) & 0x0f;
  const sampleRate = (third >> 2) & 0x03;
  return bitrate !== 0 && bitrate !== 0x0f && sampleRate !== 0x03;
}

function looksLikeWav(bytes: Uint8Array): boolean {
  return bytes.length >= 12 && ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WAVE");
}

function looksLikeFlac(bytes: Uint8Array): boolean {
  return ascii(bytes, 0, "fLaC");
}

function looksLikeOgg(bytes: Uint8Array): boolean {
  return ascii(bytes, 0, "OggS");
}

function looksLikeAac(bytes: Uint8Array): boolean {
  if (bytes.length < 2) return false;
  const first = bytes[0] ?? 0;
  const second = bytes[1] ?? 0;
  return first === 0xff && (second & 0xf6) === 0xf0;
}

function looksLikeM4a(bytes: Uint8Array): boolean {
  return bytes.length >= 12 && ascii(bytes, 4, "ftyp");
}

function looksLikeAiff(bytes: Uint8Array): boolean {
  return bytes.length >= 12 && ascii(bytes, 0, "FORM") &&
    (ascii(bytes, 8, "AIFF") || ascii(bytes, 8, "AIFC"));
}

const CHECKS: readonly {
  readonly extensions: readonly string[];
  readonly matches: (bytes: Uint8Array) => boolean;
}[] = [
  { extensions: [".mp3"], matches: looksLikeMp3 },
  { extensions: [".wav", ".wave"], matches: looksLikeWav },
  { extensions: [".flac"], matches: looksLikeFlac },
  { extensions: [".ogg", ".oga"], matches: looksLikeOgg },
  { extensions: [".aac"], matches: looksLikeAac },
  { extensions: [".m4a"], matches: looksLikeM4a },
  { extensions: [".aif", ".aiff"], matches: looksLikeAiff },
];
