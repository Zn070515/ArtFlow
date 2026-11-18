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
    await expect(participant.getByText(/报名已提交/)).toBeVisible();
    await expect(participant.getByText("已提交", { exact: true })).toBeVisible();

    await ops.goto("/login");
    await ops.getByLabel("用户名").fill("e2e-ops");
    await ops.getByLabel("密码").fill("e2e-ops-password");
    await ops.getByRole("button", { name: "登录" }).click();
    await expect(ops).toHaveURL(/\/workspace$/);

    await ops.goto("/ops");
    await ops.getByLabel("搜索活动").fill("2026 院十佳报名");
    const riskRow = ops.getByRole("row", { name: /2026 院十佳报名/ });
    await expect(riskRow).toContainText("需关注");
    await riskRow.getByText("查看原因").click();
    await expect(riskRow).toContainText("报名待审核");
    await expect(riskRow.getByRole("link", { name: "去审核" })).toHaveAttribute(
      "href",
      /#registration$/,
    );

    await ops.goto("/workspace");
    const activityCard = ops.locator(".workspace-activity-card").filter({ hasText: "2026 院十佳报名" });
    await activityCard.getByRole("link", { name: "打开活动工作台" }).click();
    await expect(ops).toHaveURL(/\/workspace\/[^/]+$/);
    await ops.getByRole("link", { name: "处理报名审核" }).click();
    await expect(ops).toHaveURL(/\/ops\/[^/]+$/);
    await expect(ops.locator("#registration")).toBeVisible();
    await expect(ops.getByRole("table")).toBeVisible();
    await ops.getByRole("table").getByRole("link").first().click();
    await expect(
      ops.getByRole("heading", { name: "2026 院十佳报名", exact: true }),
    ).toBeVisible();
    await ops.getByRole("button", { name: "批准" }).click();
    await expect(ops.getByText("当前状态「已通过」不可审核")).toBeVisible();

    await ops.goto("/ops/act-e2e-registration");
    await ops.getByRole("button", { name: "定稿名单" }).click();
    await ops.getByRole("button", { name: "确认定稿 1 人" }).click();
    await expect(ops.getByText(/已定稿 · 1 人/)).toBeVisible();

    await ops.goto("/ops");
    await ops.getByLabel("搜索活动").fill("2026 院十佳报名");
    await expect(ops.getByRole("row", { name: /2026 院十佳报名/ })).not.toContainText("报名待审核");

    await participant.goto("/me");
    await expect(participant.getByText("2026 院十佳报名")).toBeVisible();
    await expect(participant.getByText("已通过", { exact: true })).toBeVisible();
    await expect(participant.getByText("报名已通过", { exact: true })).toBeVisible();
    await participant.getByRole("link", { name: "查看详情" }).click();
    await expect(participant).toHaveURL(/\/me\/E2E-REG$/);
    await expect(participant.getByRole("heading", { name: "报名" })).toBeVisible();
    await expect(participant.getByText(/demo\.mp3/)).toBeVisible();
    await expect(participant.getByText("节目单尚未发布或没有你的条目")).toBeVisible();
    await expect(participant.getByText("赛果尚未发布")).toBeVisible();
  } finally {
    await participantContext.close().catch(() => undefined);
    await opsContext.close().catch(() => undefined);
  }
});
