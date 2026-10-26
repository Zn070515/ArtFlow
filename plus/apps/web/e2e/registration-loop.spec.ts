import { expect, test } from "@playwright/test";

test("participant submits and Ops approves the registration", async ({ browser }) => {
  const participantContext = await browser.newContext();
  const opsContext = await browser.newContext();
  const participant = await participantContext.newPage();
  const ops = await opsContext.newPage();
  const username = `e2e-p-${Date.now()}`;

  try {
    await participant.goto("/login");
    await participant.getByRole("button", { name: "没有账号？创建一个" }).click();
    await participant.getByLabel("用户名").fill(username);
    await participant.getByLabel("密码", { exact: true }).fill("participant-password");
    await participant.getByLabel("确认密码").fill("participant-password");
    await participant.getByRole("button", { name: "创建账号" }).click();

    await expect(participant).toHaveURL(/\/join$/);
    await participant.getByLabel("活动公开码").fill("E2E-REG");
    await participant.getByRole("button", { name: "继续" }).click();
    await expect(participant).toHaveURL(/\/join\/E2E-REG$/);
    await expect(
      participant.getByRole("heading", { name: "2026 院十佳报名", exact: true }),
    ).toBeVisible();

    const textboxes = participant.getByRole("textbox");
    await textboxes.nth(0).fill("Alice");
    await textboxes.nth(1).fill("夜空中最亮的星");
    await textboxes.nth(2).fill("希望把这首歌送给毕业的我们。");
    await participant.getByRole("button", { name: "保存草稿" }).click();
    await expect(participant.getByText("草稿已保存")).toBeVisible();

    await participant.locator('input[type="file"]').setInputFiles({
      name: "demo.mp3",
      mimeType: "audio/mpeg",
      buffer: Buffer.from("ID3-e2e-demo"),
    });
    await expect(participant.getByText(/demo\.mp3/)).toBeVisible();
    await participant.getByRole("button", { name: "提交报名" }).click();
    await expect(participant.getByText("报名已提交")).toBeVisible();
    await expect(participant.getByText("已提交", { exact: true })).toBeVisible();

    await ops.goto("/login");
    await ops.getByLabel("用户名").fill("e2e-ops");
    await ops.getByLabel("密码").fill("e2e-ops-password");
    await ops.getByRole("button", { name: "登录" }).click();
    await expect(ops).toHaveURL(/\/ops$/);
    await ops.getByRole("link", { name: "2026 院十佳报名" }).click();
    await expect(ops.getByRole("table")).toBeVisible();
    await ops.getByRole("link", { name: /^participant:/ }).first().click();
    await expect(
      ops.getByRole("heading", { name: "2026 院十佳报名", exact: true }),
    ).toBeVisible();
    await ops.getByRole("button", { name: "批准" }).click();
    await expect(ops.getByText("当前状态「已通过」不可审核")).toBeVisible();

    await ops.goto("/ops/act-e2e-registration");
    await ops.getByRole("button", { name: "定稿名单" }).click();
    await expect(ops.getByText(/已定稿 · 1 人/)).toBeVisible();
  } finally {
    await participantContext.close();
    await opsContext.close();
  }
});
