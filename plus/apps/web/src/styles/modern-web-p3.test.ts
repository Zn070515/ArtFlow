import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

function style(name: string): string {
  return readFileSync(join(process.cwd(), "src", "styles", name), "utf8");
}

describe("modern web P3", () => {
  it("uses individual transform properties for button states", () => {
    const ui = style("ui.css");
    const forms = style("forms.css");
    const portal = style("portal.css");
    const consoleComponents = style("console-components.css");

    expect(ui).toContain("scale: .97");
    expect(ui).not.toContain("transform: scale");
    expect(forms).toContain("translate: 0 -1px");
    expect(forms).not.toContain("transform: translateY");
    expect(portal).toContain("translate: 0 -1px");
    expect(consoleComponents).toContain("scale: .97");
  });

  it("makes the workspace activity card a size container", () => {
    const workspace = style("workspace.css");
    expect(workspace).toContain("container-type: inline-size");
    expect(workspace).toContain("@container (max-width: 420px)");
  });
});
