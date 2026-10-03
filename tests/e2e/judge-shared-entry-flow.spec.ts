import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const judgeFixturePath = process.env.PLAYWRIGHT_SHARED_JUDGE_FIXTURE_PATH;
const staffAccessKey = process.env.ARTFLOW_E2E_STAFF_ACCESS_KEY;

test("shared judge entry assigns five terminals, survives HOLD, and rejects the sixth", async ({ browser }) => {
  test.setTimeout(120_000);
  if (!judgeFixturePath) {
    throw new Error(
      "PLAYWRIGHT_SHARED_JUDGE_FIXTURE_PATH is required for the shared Judge browser flow.",
    );
  }
  if (!staffAccessKey) {
    throw new Error("ARTFLOW_E2E_STAFF_ACCESS_KEY is required for the shared Judge browser flow.");
  }

  const fixture = JSON.parse(readFileSync(judgeFixturePath, "utf8")) as {
    public_code?: unknown;
    round_id?: unknown;
    staff_username?: unknown;
    staff_password?: unknown;
  };
  if (
    typeof fixture.public_code !== "string" ||
    fixture.public_code.length < 6 ||
    typeof fixture.round_id !== "number" ||
    typeof fixture.staff_username !== "string" ||
    typeof fixture.staff_password !== "string"
  ) {
    throw new Error("Judge browser fixture does not contain a stable public code.");
  }

  const contexts = await Promise.all(
    Array.from({ length: 6 }, () => browser.newContext()),
  );
  const staffContext = await browser.newContext();
  try {
    const pages = await Promise.all(contexts.map((context) => context.newPage()));
    const entryPath = `/e/${fixture.public_code}/judge/`;
    await Promise.all(pages.slice(0, 5).map((page) => page.goto(entryPath)));

    for (const page of pages.slice(0, 5)) {
      await expect(page.locator("[data-status]")).toHaveText("评委终端已就绪。");
      await expect(page.locator("[data-activity]")).toHaveText(
        "Judge browser fixture activity",
      );
    }
    await pages[5].goto(entryPath);
    await expect(pages[5].locator("[data-status]")).toHaveText(
      "评委会话无效或已过期，请重新扫描现场二维码。",
    );

    const seatLabels = await Promise.all(
      pages.slice(0, 5).map((page) => page.locator("[data-seat-label]").textContent()),
    );
    expect(new Set(seatLabels)).toEqual(new Set(["J1", "J2", "J3", "J4", "J5"]));

    const staff = await staffContext.newPage();
    await staff.goto("/login/staff/");
    await staff.getByLabel("用户名").fill(fixture.staff_username);
    await staff.getByLabel("密码").fill(fixture.staff_password);
    await staff.getByLabel("工作人员密钥").fill(staffAccessKey);
    await staff.getByRole("button", { name: "登录" }).click();
    await expect(staff).toHaveURL(/\/staff\/$/);

    await staff.goto(`/staff/judges/round/${fixture.round_id}/control/`);
    await staff.getByRole("button", { name: "暂停评委组" }).click();
    await expect(staff.getByText("评委组已暂停")).toBeVisible();
    await expect(pages[0].locator("[data-performance-state]")).toHaveText("现场暂停");
    await expect(pages[0].locator("[data-submit]")).toBeDisabled();

    await staff.getByRole("button", { name: "恢复评委组" }).click();
    await expect(staff.getByText("评委组已恢复")).toBeVisible();
    await expect(pages[0].locator("[data-performance-state]")).toHaveText("评分中");
    await expect(pages[0].locator("[data-submit]")).toBeEnabled();
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
    await staffContext.close();
  }
});
