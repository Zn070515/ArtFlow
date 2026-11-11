import { readFileSync } from "node:fs";

import { expect, test } from "@playwright/test";

interface AttendanceFixture {
  readonly activityId: string;
  readonly pointKey: string;
  readonly ticketCredential: string;
  readonly ticketPublicCode: string;
}

const fixture = JSON.parse(
  readFileSync(new URL("../.e2e-attendance.json", import.meta.url), "utf8"),
) as AttendanceFixture;

test("ops opens check-in, checks in a participant, staff member, and ticket", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("用户名").fill("e2e-ops");
  await page.getByLabel("密码").fill("e2e-ops-password");
  await page.getByRole("button", { name: "登录" }).click();
  await page.waitForURL(/\/ops$/);

  await page.goto(`/ops/${fixture.activityId}`);
  const card = page.getByTestId("attendance-card");
  await expect(card).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept());
  await card.getByRole("button", { name: "打开签到" }).click();
  await expect(card.getByText("签到已开放（正式）")).toBeVisible();
  await card.getByLabel("签到点").selectOption(fixture.pointKey);

  const participantRow = card.locator("li", { hasText: "选手甲" });
  await participantRow.getByRole("button", { name: "签到" }).click();
  await expect(participantRow.getByText("已到")).toBeVisible();
  await participantRow.getByRole("button", { name: "撤销" }).click();
  await expect(participantRow.getByText("已撤销")).toBeVisible();
  await participantRow.getByRole("button", { name: "签到" }).click();
  await expect(participantRow.getByText("已到")).toBeVisible();

  await card.getByRole("tab", { name: "工作人员" }).click();
  const staffRow = card.locator("li", { hasText: "志愿者甲" });
  await staffRow.getByRole("button", { name: "签到" }).click();
  await expect(staffRow.getByText("已到")).toBeVisible();

  await card.getByRole("tab", { name: "票据" }).click();
  await card.getByPlaceholder("粘贴票据 credential").fill(fixture.ticketCredential);
  await card.getByRole("button", { name: "按凭证签到" }).click();
  const ticketRow = card.locator("li", { hasText: fixture.ticketPublicCode });
  await expect(ticketRow.getByText("已到")).toBeVisible();

  await card.getByRole("button", { name: "关闭签到" }).click();
  await expect(card.getByRole("button", { name: "打开签到" })).toBeVisible();
});
