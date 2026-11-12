import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readAllStyles } from "../../styles/read-styles.js";

const webSource = join(process.cwd(), "src");

describe("Ops style contracts", () => {
  it("uses the shared Button primitive", async () => {
    const grouping = await readFile(join(webSource, "components", "ops", "GroupingCard.tsx"), "utf8");
    const voting = await readFile(join(webSource, "components", "ops", "VotingCard.tsx"), "utf8");

    expect(grouping).not.toContain("<button");
    expect(voting).not.toContain("<button");
    expect(grouping).toContain("<Button");
    expect(voting).toContain("<Button");
  });

  it("declares layout rules for the voting controls", async () => {
    const global = await readAllStyles(join(webSource, "styles"));

    expect(global).toContain(".voting-sessions");
    expect(global).toContain(".voting-new");
    expect(global).toContain(".voting-actions");
  });
});
