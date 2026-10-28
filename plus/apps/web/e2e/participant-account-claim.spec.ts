import { expect, test } from "@playwright/test";

test("adopted legacy participant claims an account and reads the imported registration", async ({ browser }) => {
  const opsContext = await browser.newContext();
  const participantContext = await browser.newContext();
  const secondParticipantContext = await browser.newContext();
  const ops = await opsContext.newPage();
  const participant = await participantContext.newPage();
  const secondParticipant = await secondParticipantContext.newPage();
  const username = `e2e-claim-${Date.now()}`;
  const password = "participant-claim-password";

  try {
    await ops.goto("/login");
    await ops.getByLabel("用户名").fill("e2e-ops");
    await ops.getByLabel("密码").fill("e2e-ops-password");
    await ops.getByRole("button", { name: "登录" }).click();
    await expect(ops).toHaveURL(/\/ops$/);
    await ops.goto("/ops/act-e2e-registration");
    await ops.getByRole("link", { name: "legacy-user:e2e" }).click();
    await expect(ops.getByRole("heading", { name: "2026 院十佳报名", exact: true })).toBeVisible();
    await ops.getByRole("button", { name: "生成参与者认领链接" }).click();
    const claimLink = await ops.getByLabel("一次性认领链接").inputValue();
    expect(claimLink).toMatch(/\/claim#/);

    await participant.goto(claimLink);
    await expect(participant).toHaveURL(/\/claim$/);
    await participant.getByLabel("用户名").fill(username);
    await participant.getByLabel("密码", { exact: true }).fill(password);
    await participant.getByLabel("确认密码").fill(password);
    await participant.getByRole("button", { name: "创建账号并继续" }).click();
    await expect(participant).toHaveURL(/\/join\/E2E-REG$/);
    await expect(participant.getByText("legacy-user:e2e")).toBeVisible();
    await expect(participant.locator("textarea").nth(0)).toHaveValue("Legacy Alice");
    await expect(participant.locator("textarea").nth(1)).toHaveValue("导入的旧曲目");

    await participant.reload();
    await expect(participant.locator("textarea").nth(0)).toHaveValue("Legacy Alice");

    await secondParticipant.goto(claimLink);
    await secondParticipant.getByLabel("用户名").fill(`e2e-claim-replay-${Date.now()}`);
    await secondParticipant.getByLabel("密码", { exact: true }).fill(password);
    await secondParticipant.getByLabel("确认密码").fill(password);
    await secondParticipant.getByRole("button", { name: "创建账号并继续" }).click();
    await expect(secondParticipant.getByRole("alert")).toContainText("认领链接无效或已过期");
  } finally {
    await opsContext.close();
    await participantContext.close();
    await secondParticipantContext.close();
  }
});
