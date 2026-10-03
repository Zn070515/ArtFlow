import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const judgeFixturePath = process.env.PLAYWRIGHT_SHARED_JUDGE_FIXTURE_PATH;

test("shared judge entry assigns five terminals and rejects the sixth", async ({ browser }) => {
  if (!judgeFixturePath) {
    throw new Error(
      "PLAYWRIGHT_JUDGE_FIXTURE_PATH is required for the shared Judge browser flow.",
    );
  }

  const fixture = JSON.parse(readFileSync(judgeFixturePath, "utf8")) as {
    public_code?: unknown;
  };
  if (typeof fixture.public_code !== "string" || fixture.public_code.length < 6) {
    throw new Error("Judge browser fixture does not contain a stable public code.");
  }

  const contexts = await Promise.all(
    Array.from({ length: 6 }, () => browser.newContext()),
  );
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
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
