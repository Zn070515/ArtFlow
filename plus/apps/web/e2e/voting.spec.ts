import { expect, request as apiRequest, test } from "@playwright/test";

test("ops runs a vote and publishes the live result", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("用户名").fill("e2e-ops");
  await page.getByLabel("密码").fill("e2e-ops-password");
  await page.getByRole("button", { name: "登录" }).click();
  await page.waitForURL(/\/ops$/);

  await page.goto("/ops/act_e2e_voting");
  await expect(page.getByRole("heading", { name: "投票与发布" })).toBeVisible();

  // Start the two execution sessions the card needs.
  const sessionRows = page.locator(".voting-session-row");
  await sessionRows.filter({ hasText: "voting 会话" }).getByRole("button", { name: "启动" }).click();
  await expect(sessionRows.filter({ hasText: "voting 会话" }).getByText("运行中")).toBeVisible();
  await sessionRows.filter({ hasText: "publishing 会话" }).getByRole("button", { name: "启动" }).click();
  await expect(sessionRows.filter({ hasText: "publishing 会话" }).getByText("运行中")).toBeVisible();

  // Open a vote with two candidates.
  await page.getByLabel("候选（每行一个）").fill("alice\nbob");
  await page.getByRole("button", { name: "开启投票" }).click();
  await expect(page.getByText(/alice · 0 票/)).toBeVisible();

  // Cast a ballot through the public route using the browser identity cookie.
  const activityId = "act_e2e_voting";
  const sessions = await page.request.get(`/api/activities/${activityId}/voting/sessions`);
  const session = (await sessions.json()).sessions[0] as {
    id: string;
    candidates: { optionId: string; candidateId: string }[];
  };
  // A voter is anonymous: a fresh request context has no Ops session cookie,
  // so the write does not require a CSRF token.
  const voter = await apiRequest.newContext({ baseURL: new URL(page.url()).origin });
  await voter.get(`/api/activities/${activityId}/voting/browser-identity`);
  const alice = session.candidates.find((candidate) => candidate.candidateId === "alice");
  if (alice === undefined) throw new Error("alice option missing");
  const ballot = await voter.post(
    `/api/activities/${activityId}/voting/sessions/${session.id}/ballots`,
    {
      headers: { "idempotency-key": `e2e-ballot-${Date.now()}` },
      data: { scope: "voting", optionIds: [alice.optionId], identity: { type: "browser" } },
    },
  );
  expect(ballot.ok(), await ballot.text()).toBe(true);
  await voter.dispose();

  // The card updates over WebSocket without a reload.
  await expect(page.getByText(/alice · 1 票/)).toBeVisible({ timeout: 10_000 });

  await page.getByRole("button", { name: "关闭场次" }).click();
  await page.getByRole("button", { name: "预览结果" }).click();
  await expect(page.getByText("结果预览")).toBeVisible();
  await page.getByRole("button", { name: "确认赛果" }).click();
  await page.getByLabel("发布备注").fill("人气投票结果");
  await page.getByRole("button", { name: "发布结果" }).click();

  // The release command commits asynchronously; poll the public selector
  // instead of assuming the mutation finished before the next HTTP read.
  await expect.poll(async () => {
    const response = await page.request.get("/api/public/results/E2E-VOTING");
    if (!response.ok()) return 0;
    const body = await response.json() as { results: unknown[] };
    return body.results.length;
  }, { timeout: 10_000 }).toBeGreaterThan(0);
  const publicRead = await page.request.get("/api/public/results/E2E-VOTING");
  expect(publicRead.ok()).toBe(true);
  const publicBody = await publicRead.json() as {
    results: { decisions: { contestantId: string; unit?: string }[] }[];
  };
  expect(publicBody.results[0]?.decisions[0]).toMatchObject({
    contestantId: "alice",
    unit: "percent",
  });
  expect(publicBody.results[0]?.decisions[1]).toMatchObject({
    contestantId: "bob",
    unit: "percent",
  });
});
