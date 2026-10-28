import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const webSource = join(process.cwd(), "src");

describe("Ops style contracts", () => {
  it("uses the shared button class names", async () => {
    const grouping = await readFile(join(webSource, "components", "ops", "GroupingCard.tsx"), "utf8");

    expect(grouping).not.toContain('className="button-primary"');
    expect(grouping).not.toContain('className="button-secondary"');
  });

  it("declares layout rules for the voting controls", async () => {
    const global = await readFile(join(webSource, "styles", "global.css"), "utf8");

    expect(global).toContain(".voting-sessions");
    expect(global).toContain(".voting-new");
    expect(global).toContain(".voting-actions");
  });
});
