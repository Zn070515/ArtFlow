import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readAllStyles } from "./read-styles.js";

const sourceDirectory = join(process.cwd(), "src", "components", "workspace");
const stylesDirectory = join(process.cwd(), "src", "styles");

describe("Organizer workspace style contracts", () => {
  it("declares workspace layout and component classes", async () => {
    const styles = await readAllStyles(stylesDirectory);
    const requiredClasses = [
      ".workspace-page",
      ".workspace-activity-grid",
      ".workspace-activity-card",
      ".workspace-next-action",
      ".workspace-progress-list",
      ".workspace-activity-switcher",
      ".workspace-quick-links",
    ];

    for (const className of requiredClasses) expect(styles).toContain(className);
  });

  it("keeps workspace styles on Console tokens and includes responsive layout rules", async () => {
    const workspace = await readFile(join(stylesDirectory, "workspace.css"), "utf8");

    expect(workspace).toContain("var(--color-text)");
    expect(workspace).toContain("var(--color-line)");
    expect(workspace).toContain("@media (max-width: 1023px)");
    expect(workspace).toContain("@media (max-width: 767px)");
    expect(workspace).not.toMatch(/#[0-9a-f]{3,8}/i);
  });

  it("does not leave workspace markup outside the declared style partial", async () => {
    const sourceFiles = ["ActivitySwitcher.tsx", "WorkspaceActivityCard.tsx", "WorkspaceNextAction.tsx", "WorkspaceProgress.tsx"];
    const source = (await Promise.all(sourceFiles.map((file) => readFile(join(sourceDirectory, file), "utf8")))).join("\n");
    const styles = await readAllStyles(stylesDirectory);
    const classNames = [...source.matchAll(/className="([^"]+)"/g)].flatMap((match) => (match[1] ?? "").split(/\s+/));

    for (const className of classNames.filter((value) => value.startsWith("workspace-"))) {
      expect(styles).toContain(`.${className}`);
    }
  });
});
