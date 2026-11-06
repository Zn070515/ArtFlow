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

test("a ticket holder redeems a ticket and votes through the public page", async ({
  page,
  browser,
}) => {
  await page.goto("/login");
  await page.getByLabel("用户名").fill("e2e-ops");
  await page.getByLabel("密码").fill("e2e-ops-password");
  await page.getByRole("button", { name: "登录" }).click();
  await page.waitForURL(/\/ops$/);

  const activityId = "act_e2e_ticket_vote_page";
  await page.goto("/ops/" + activityId);
  const sessionRows = page.locator(".voting-session-row");
  await sessionRows.filter({ hasText: "voting 会话" }).getByRole("button", { name: "启动" }).click();
  await expect(sessionRows.filter({ hasText: "voting 会话" }).getByText("运行中")).toBeVisible();
  await page.getByLabel("候选（每行一个）").fill("alice\nbob");
  await page.getByRole("button", { name: "开启投票" }).click();
  await expect(page.locator(".voting-session").first()).toBeVisible();

  const sessions = await page.request.get("/api/activities/" + activityId + "/voting/sessions");
  const session = (await sessions.json()).sessions[0] as { id: string };
  const csrf = await page.evaluate(() => document.cookie.split("; ").find((entry) => entry.startsWith("artflow_csrf="))?.slice("artflow_csrf=".length));
  if (csrf === undefined) throw new Error("The Ops CSRF cookie was not available.");
  const issued = await page.request.post("/api/activities/" + activityId + "/tickets", {
    headers: { "idempotency-key": "e2e-ticket-vote-" + Date.now(), "x-csrf-token": csrf },
    data: {},
  });
  expect(issued.ok(), await issued.text()).toBe(true);
  const issuedBody = await issued.json() as { credential?: string };
  if (issuedBody.credential === undefined) throw new Error("The E2E ticket credential was not returned.");

  const voterContext = await browser.newContext();
  const voter = await voterContext.newPage();
  await voter.goto("/vote/" + encodeURIComponent(session.id) + "#ticket=" + encodeURIComponent(issuedBody.credential));
  await expect(voter.getByRole("heading", { name: "E2E 票据投票页" })).toBeVisible();
  await expect(voter.getByRole("radio", { name: "alice" })).toBeVisible();
  expect(voter.url()).not.toContain("ticket=");
  await voter.getByRole("radio", { name: "alice" }).check();
  await voter.getByRole("button", { name: "投票" }).click();
  await expect(voter.getByText("投票成功，谢谢参与。")).toBeVisible();

  await voter.reload();
  await expect(voter.getByText("你已经投过票了。")).toBeVisible();
  await voterContext.close();

  const secondIssued = await page.request.post("/api/activities/" + activityId + "/tickets", {
    headers: { "idempotency-key": "e2e-ticket-vote-second-" + Date.now(), "x-csrf-token": csrf },
    data: {},
  });
  expect(secondIssued.ok(), await secondIssued.text()).toBe(true);
  const secondBody = await secondIssued.json() as { credential?: string };
  if (secondBody.credential === undefined) throw new Error("The second E2E ticket credential was not returned.");
  const manualContext = await browser.newContext();
  const manual = await manualContext.newPage();
  await manual.goto("/vote/" + encodeURIComponent(session.id));
  await expect(manual.getByLabel("票据凭证")).toBeVisible();
  await manual.getByLabel("票据凭证").fill(secondBody.credential);
  await manual.getByRole("button", { name: "验证票据" }).click();
  await expect(manual.getByRole("radio", { name: "alice" })).toBeVisible();
  await manual.getByRole("radio", { name: "alice" }).check();
  await manual.getByRole("button", { name: "投票" }).click();
  await expect(manual.getByText("投票成功，谢谢参与。")).toBeVisible();
  await manualContext.close();
});
