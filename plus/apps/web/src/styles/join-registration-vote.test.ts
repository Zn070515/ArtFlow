import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sourceDirectory = join(process.cwd(), "src");

describe("Join, Registration, and Vote layout contracts", () => {
  it("declares the Console form surfaces and responsive question grid", async () => {
    const global = await readFile(join(sourceDirectory, "styles", "global.css"), "utf8");

    expect(global).toContain(".join-page");
    expect(global).toContain(".join-code-card");
    expect(global).toContain(".registration-question-grid");
    expect(global).toContain(".question-full-row");
    expect(global).toContain(".registration-actions");
    expect(global).toContain("@media (max-width: 1023px)");
    expect(global).toContain("grid-template-columns: 1fr");
  });

  it("declares the Portal Vote workspace and no legacy button class remains", async () => {
    const global = await readFile(join(sourceDirectory, "styles", "global.css"), "utf8");
    const vote = await readFile(join(sourceDirectory, "routes", "vote.tsx"), "utf8");

    expect(global).toContain(".vote-workspace");
    expect(global).toContain(".vote-selection");
    expect(global).toContain(".vote-action-panel");
    expect(global).toContain(".vote-credential-panel");
    expect(vote).not.toContain('className="button-primary"');
  });

  it("removes obsolete pre-Console registration selectors", async () => {
    const global = await readFile(join(sourceDirectory, "styles", "global.css"), "utf8");

    expect(global).not.toMatch(/\.registration-panel(?:\s|[.{:#,])/);
    expect(global).not.toMatch(/\.registration-head(?:\s|[.{:#,])/);
    expect(global).not.toMatch(/\.question-list(?:\s|[.{:#,])/);
  });
});
