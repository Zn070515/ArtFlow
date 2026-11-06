import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const stylesDirectory = join(process.cwd(), "src", "styles");

describe("Studio Console layout styles", () => {
  it("declares the main column and sticky operational rail", async () => {
    const global = await readFile(join(stylesDirectory, "global.css"), "utf8");

    expect(global).toContain(".studio-main-column");
    expect(global).toContain(".studio-rail");
    expect(global).toContain("grid-template-columns: minmax(0, 1fr) 360px");
    expect(global).toContain("min-height: 520px");
  });

  it("moves the Studio rail below the editor at the Console breakpoint", async () => {
    const global = await readFile(join(stylesDirectory, "global.css"), "utf8");
    const studioStyles = global.slice(global.indexOf(".console-page .studio-grid"));

    expect(studioStyles).toContain("position: sticky");
    expect(studioStyles).toContain("@media (max-width: 1023px)");
    expect(studioStyles).toContain("grid-template-columns: 1fr");
  });
});
