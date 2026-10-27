import { expect, test } from "@playwright/test";

test("a voter opens the shared link, votes, and sees the already-voted state", async ({
  page,
  browser,
}) => {
  await page.goto("/login");
  await page.getByLabel("用户名").fill("e2e-ops");
  await page.getByLabel("密码").fill("e2e-ops-password");
  await page.getByRole("button", { name: "登录" }).click();
  await page.waitForURL(/\/ops$/);

  await page.goto("/ops/act_e2e_vote_page");
  const sessionRows = page.locator(".voting-session-row");
  await sessionRows.filter({ hasText: "voting 会话" }).getByRole("button", { name: "启动" }).click();
  await expect(sessionRows.filter({ hasText: "voting 会话" }).getByText("运行中")).toBeVisible();

  await page.getByLabel("候选（每行一个）").fill("alice\nbob");
  await page.getByRole("button", { name: "开启投票" }).click();
  await expect(page.getByAltText("投票二维码")).toBeVisible();
  await expect(page.getByRole("link", { name: /\/vote\// })).toBeVisible();

  const sessions = await page.request.get("/api/activities/act_e2e_vote_page/voting/sessions");
  const session = (await sessions.json()).sessions[0] as { id: string };

  const voterContext = await browser.newContext();
  const voter = await voterContext.newPage();
  await voter.goto(`/vote/${session.id}`);
  await expect(voter.getByRole("heading", { name: "E2E 投票页" })).toBeVisible();
  await voter.getByRole("radio", { name: "alice" }).check();
  await voter.getByRole("button", { name: "投票" }).click();
  await expect(voter.getByText("投票成功，谢谢参与。")).toBeVisible();

  await voter.reload();
  await expect(voter.getByText("你已经投过票了。")).toBeVisible();

  await expect(page.getByText(/alice · 1 票/)).toBeVisible({ timeout: 10_000 });
  await voterContext.close();
});
