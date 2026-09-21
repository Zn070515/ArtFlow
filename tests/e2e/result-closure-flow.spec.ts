import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const closureFixturePath = process.env.PLAYWRIGHT_CLOSURE_FIXTURE_PATH;

type ClosureFixture = {
  session_cookie: string;
  csrf_token: string;
  closure_path: string;
  detail_path: string;
  confirm_path: string;
  unlock_path: string;
  stage_key: string;
  input_fingerprint_prefix: string;
};

test.describe("result closure UI authority", () => {
  test.skip(!closureFixturePath, "PLAYWRIGHT_CLOSURE_FIXTURE_PATH is required.");

  test("uses exact persisted status, exposes the safe fingerprint prefix, and unlocks through UI", async ({
    context,
    page,
  }) => {
    const fixture = JSON.parse(readFileSync(closureFixturePath!, "utf8")) as ClosureFixture;
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:8000";
    const cookies = fixture.session_cookie.split(/;\s*/).map((cookie) => {
      const separator = cookie.indexOf("=");
      if (separator <= 0) throw new Error("Invalid closure fixture session cookie.");
      return {
        name: cookie.slice(0, separator),
        value: cookie.slice(separator + 1),
        url: baseURL,
      };
    });
    await context.addCookies(cookies);

    await page.goto(fixture.closure_path);
    const closureStage = page.locator(`[data-stage-key="${fixture.stage_key}"]`);
    await expect(closureStage).toHaveAttribute("data-stage-status", "ready_to_confirm");
    await expect(closureStage).toHaveAttribute("data-input-fingerprint-prefix", fixture.input_fingerprint_prefix);
    await expect(closureStage.locator("[data-result-version]")).toHaveText("1");
    expect(await page.locator("body").textContent()).not.toContain("sessionid=");

    await page.goto(fixture.detail_path);
    const detailStage = page.locator("[data-stage-status]").first();
    await expect(detailStage).toHaveAttribute("data-stage-status", "ready_to_confirm");
    const confirmForm = page.locator(`form[action="${fixture.confirm_path}"]`);
    await expect(confirmForm).toHaveCount(1);
    await confirmForm.locator("button[type=submit]").click();
    await expect(page).toHaveURL(new RegExp(`${fixture.detail_path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
    await expect(page.locator('[data-stage-status="confirmed"]')).toHaveCount(1);

    const unlockForm = page.locator("[data-stage-result-unlock-form]");
    await expect(unlockForm).toHaveCount(1);
    await unlockForm.locator("textarea[name=note]").fill("UI rehearsal correction");
    await unlockForm.locator("button[type=submit]").click();
    await expect(page.locator('[data-stage-status="ready_to_confirm"]')).toHaveCount(1);
    await expect(page.locator("[data-stage-result-unlock-form]")).toHaveCount(0);
  });
});
