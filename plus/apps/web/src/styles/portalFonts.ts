/**
 * Portal-only display fonts. Keeping them behind a dynamic import means the
 * Console bundle never pays for Instrument Serif or Noto Serif SC; the Portal
 * shell requests them when it mounts.
 */
export async function loadPortalFonts(): Promise<void> {
  try {
    await Promise.all([
      import("@fontsource/instrument-serif"),
      import("@fontsource-variable/noto-serif-sc"),
    ]);
  } catch {
    // The Portal keeps its system serif fallback if the font chunks fail.
  }
}
