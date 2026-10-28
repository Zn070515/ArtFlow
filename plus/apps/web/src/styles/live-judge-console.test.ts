import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const stylesDirectory = join(process.cwd(), "src", "styles");

describe("Live and Judge Console layout styles", () => {
  it("declares the Live workspace and sticky control rail", async () => {
    const global = await readFile(join(stylesDirectory, "global.css"), "utf8");

    expect(global).toContain(".live-workspace");
    expect(global).toContain(".live-main-column");
    expect(global).toContain(".live-control-rail");
    expect(global).toContain("grid-template-columns: minmax(0, 1fr) 360px");
    expect(global).toContain("position: sticky");
  });

  it("declares a focused 720px Judge workspace and mobile fallback", async () => {
    const global = await readFile(join(stylesDirectory, "global.css"), "utf8");

    expect(global).toContain(".judge-workspace");
    expect(global).toContain(".judge-score-column");
    expect(global).toContain("max-width: 720px");
    expect(global).toContain("@media (max-width: 1023px)");
    expect(global).toContain("grid-template-columns: 1fr");
  });
});
