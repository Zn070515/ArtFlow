import { expect, test } from "@playwright/test";
import { readFileSync, unlinkSync } from "node:fs";

const fixturePath = process.env.PLAYWRIGHT_QUESTIONNAIRE_FIXTURE_PATH;
let fixture: { activity_id: number; username: string; password: string };

test.beforeAll(() => {
  if (!fixturePath) {
    throw new Error(
      "PLAYWRIGHT_QUESTIONNAIRE_FIXTURE_PATH is required for the questionnaire browser flow.",
    );
  }
  fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as typeof fixture;
  if (
    !Number.isInteger(fixture.activity_id) ||
    typeof fixture.username !== "string" ||
    typeof fixture.password !== "string"
  ) {
    throw new Error("Questionnaire browser fixture is malformed.");
  }
});

test.afterAll(() => {
  if (!fixturePath) return;
  try {
    unlinkSync(fixturePath);
  } catch {
    // CI cleanup also removes the fixture; it may already be gone.
  }
});

test("participant completes the canonical questionnaire flow", async ({ page }) => {
  await page.goto(`/login/participant/?next=/contest/register/${fixture.activity_id}/`);
  await page.getByLabel("用户名").fill(fixture.username);
  await page.getByLabel("密码").fill(fixture.password);
  await page.getByRole("button", { name: "登录" }).click();

  await expect(page).toHaveURL(new RegExp(`/questionnaire/${fixture.activity_id}/$`));
  await expect(page.getByText("资料完成度")).toBeVisible();
  await page.getByLabel("姓名").fill("浏览器测试选手");
  await page.getByLabel("第一轮曲目").fill("浏览器测试曲目");
  await expect(page.locator("[data-save-state]")).toHaveText("已保存", { timeout: 5_000 });

  await page.locator('input[type="file"][data-file-answer="r1.accompaniment"]').setInputFiles({
    name: "browser-fixture.wav",
    mimeType: "audio/wav",
    buffer: Buffer.from("RIFF\x00\x00\x00\x00WAVE\x00\x00\x00\x00", "latin1"),
  });
  await expect(page.locator("[data-save-state]")).toHaveText("已上传", { timeout: 5_000 });

  await page.getByRole("button", { name: "提交报名" }).click();
  await expect(page.locator("[data-submit-state]")).toHaveText(/已提交/);

  await page.getByLabel("第一轮曲目").fill("浏览器修订曲目");
  await expect(page.locator("[data-save-state]")).toHaveText("已保存", { timeout: 5_000 });
  await expect(page.locator('[data-answer="r1.song"]')).toHaveValue("浏览器修订曲目");
});
