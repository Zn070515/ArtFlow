import { readFileSync, unlinkSync } from "node:fs";
import { expect, test } from "@playwright/test";

const judgeFixturePath = process.env.PLAYWRIGHT_JUDGE_FIXTURE_PATH;
let judgeGrantToken: string;

test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  if (!judgeFixturePath) {
    throw new Error(
      "PLAYWRIGHT_JUDGE_FIXTURE_PATH is required for the Judge browser authority flow.",
    );
  }
  const fixture = JSON.parse(readFileSync(judgeFixturePath, "utf8")) as {
    grant_token?: unknown;
  };
  if (typeof fixture.grant_token !== "string" || fixture.grant_token.length < 32) {
    throw new Error("Judge browser fixture does not contain a valid grant token.");
  }
  judgeGrantToken = fixture.grant_token;
});

test.afterAll(() => {
  if (!judgeFixturePath) return;
  try {
    unlinkSync(judgeFixturePath);
  } catch {
    // The CI cleanup step also removes the fixture; it may already be gone.
  }
});

test("judge terminal never exposes a credential without a QR fragment", async ({ page }) => {
  const response = await page.goto("/judge/terminal/");

  expect(response?.status()).toBe(200);
  await expect(page.locator("[data-status]")).toHaveText(/二维码/);
  await expect(page.locator("[data-round]")).toBeVisible();
  await expect(page.locator("[data-performance-label]")).toBeVisible();
  await expect(page.locator("[data-singer]")).toBeVisible();
  await expect(page.locator("[data-song]")).toBeVisible();
  await expect(page.locator("[data-performance-state]")).toBeVisible();
  await expect(page.locator("[data-submit]")).toBeDisabled();
  expect(await page.content()).not.toContain("session_token");
  expect(page.url()).not.toContain("#");
});

test("judge context rejects an unauthenticated browser request generically", async ({ request }) => {
  const response = await request.get("/judge/context/");

  expect(response.status()).toBe(401);
  expect(await response.json()).toEqual({
    detail: "评委请求未被接受。",
    reason_code: "INVALID_JUDGE_SESSION",
  });
  expect(response.headers()["cache-control"]).toContain("no-store");
});

test("judge score rejects cross-origin bearer attempts without echoing the credential", async ({ request }) => {
  const rawCredential = "judge-browser-secret";
  const response = await request.post("/judge/score/", {
    data: {},
    headers: { Authorization: `Bearer ${rawCredential}`, Origin: "https://evil.example" },
  });

  expect(response.status()).toBe(403);
  expect(await response.text()).not.toContain(rawCredential);
});

test("judge browser completes redeem, context, ACK-loss retry, and idempotent receipt", async ({ page }) => {
  let scoreRequests = 0;
  let droppedFirstResponse = false;
  await page.route("**/judge/score/", async (route) => {
    scoreRequests += 1;
    const response = await route.fetch();
    if (!droppedFirstResponse) {
      droppedFirstResponse = true;
      await route.abort("failed");
      return;
    }
    await route.fulfill({ response });
  });

  await page.goto(`/judge/terminal/#${encodeURIComponent(judgeGrantToken)}`);
  await expect(page.locator("[data-status]")).toHaveText("评委终端已就绪。");
  await expect(page.locator("[data-performance-state]")).toHaveText("评分中");

  await page.locator("[data-score]").fill("91.50");
  const submit = page.locator("[data-submit]");
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page.locator("[data-status]")).toHaveText(/网络暂时不可用/);

  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page.locator("[data-status]")).toHaveText("评分已确认。");
  expect(scoreRequests).toBe(2);
  const finalUrl = new URL(page.url());
  expect(finalUrl.pathname).toBe("/judge/terminal/");
  expect(finalUrl.hash).toBe("");
});
