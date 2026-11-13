import { expect, test } from "@playwright/test";

test("recovers a live result through revoke, correction, tie, and re-publish", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("用户名").fill("e2e-ops");
  await page.getByLabel("密码").fill("e2e-ops-password");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(/\/workspace$/);

  await page.goto("/live/act_e2e_recovery");
  await expect(page.getByRole("heading", { name: "E2E Recovery", exact: true })).toBeVisible();

  const resultActions = page.getByTestId("live-result-actions");
  const round = page.getByTestId("live-round-final");
  const exceptions = page.getByTestId("live-exceptions-final");
  const tiePanel = page.getByTestId("live-tie-advancement-final");

  // B. Revoke the seeded release and publish it again.
  const note = resultActions.getByLabel("发布 / 归档说明");
  await note.fill("现场撤回");
  await resultActions.getByRole("button", { name: "撤销发布" }).click();
  await expect(page.locator('[data-release-status="revoked"]').first()).toBeVisible();

  await resultActions.getByRole("button", { name: "发布赛果" }).click();
  await expect(page.locator('[data-release-status="active"]').first()).toBeVisible();

  // A. Unlock the consumed result, correct singer-c, rebuild the ranking, decide
  // the crossing tie, finalize advancement, and publish the new result.
  await resultActions.getByRole("button", { name: "解锁赛果" }).click();
  await expect(resultActions.getByRole("button", { name: "解锁赛果" })).toHaveCount(0);

  page.once("dialog", (dialog) => void dialog.accept("现场核对分数"));
  await round.getByRole("button", { name: "打开评分更正窗口" }).click();
  await expect(round.getByRole("heading", { name: /final · scoring/ })).toBeVisible();

  const contestantRow = exceptions.locator('[data-contestant="singer-c"]');
  await expect(contestantRow).toBeVisible();
  await contestantRow.getByRole("button", { name: "开修正" }).click();
  await contestantRow.getByLabel("修正原因").fill("看错分");
  await contestantRow.getByRole("button", { name: "确认开修正" }).click();
  await expect(contestantRow.getByRole("button", { name: "保存修正" })).toBeVisible();

  await contestantRow.getByLabel("total").fill("85");
  await contestantRow.getByRole("button", { name: "保存修正" }).click();
  await expect(contestantRow.getByRole("button", { name: "关闭修正" })).toBeVisible();
  await contestantRow.getByRole("button", { name: "关闭修正" }).click();
  await expect(contestantRow.getByRole("button", { name: "重算" })).toBeVisible();
  await contestantRow.getByRole("button", { name: "重算" }).click();
  await expect(exceptions.getByText("重算完成")).toBeVisible();

  // Reopening only reopens the round; every performance stays locked, so lock
  // the round before asking for a fresh ranking.
  await round.getByRole("button", { name: "锁轮" }).click();
  await expect(round.getByRole("heading", { name: /final · locked/ })).toBeVisible();
  await round.getByRole("button", { name: "生成排名" }).click();
  await expect(round.getByRole("table", { name: /当前排名（revision \d+）/ })).toBeVisible();

  await expect(tiePanel.getByText(/晋级线附近有平局/)).toBeVisible();
  await tiePanel.getByLabel("裁决原因").fill("现场裁决");
  await tiePanel.getByRole("button", { name: "记录裁决" }).click();
  await expect(tiePanel.getByText("已记录裁决")).toBeVisible();
  await expect(tiePanel.getByRole("button", { name: "晋级定稿" })).toBeEnabled();
  await tiePanel.getByRole("button", { name: "晋级定稿" }).click();
  await expect(tiePanel.getByText(/已定稿/)).toBeVisible();

  await resultActions.getByRole("button", { name: "生成领奖候选" }).click();
  await expect(resultActions.getByText(/候选 #/)).toBeVisible();
  await resultActions.getByRole("button", { name: "确认评委赛果" }).click();
  await expect(resultActions.getByRole("button", { name: "发布赛果" })).toBeEnabled();
  await resultActions.getByRole("button", { name: "发布赛果" }).click();
  await expect(page.locator('[data-release-status="active"]').first()).toBeVisible();
});
