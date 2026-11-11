import { readFile } from "node:fs/promises";
import { join } from "node:path";

async function readEntry(stylesDirectory: string, name: string): Promise<string> {
  const text = await readFile(join(stylesDirectory, name), "utf8");
  const imported = [...text.matchAll(/@import\s+"\.\/([^"]+)";/g)].map((match) => match[1]);
  if (imported.length === 0) return text;
  const parts = await Promise.all(
    imported.map((entry) => readEntry(stylesDirectory, entry ?? "global.css")),
  );
  // CSS inlines each `@import` at its position, and every entry file declares
  // its imports first. Concatenate the partials first and the entry's own rules
  // (everything except the imports) after them, as the bundler does.
  const ownRules = text.replace(/@import\s+"\.\/[^"]+";/g, "");
  return [...parts, ownRules].join("\n");
}

/**
 * Read the style entry and every nested partial in cascade order. Tests assert
 * on selectors, so they must see the same concatenation the bundler produces,
 * not just the top-level @import entry file.
 */
export async function readAllStyles(stylesDirectory: string): Promise<string> {
  return readEntry(stylesDirectory, "global.css");
}
