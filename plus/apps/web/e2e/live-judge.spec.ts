import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

interface LiveSeed {
  readonly activityId: string;
  readonly publicCode: string;
  readonly title: string;
}

function readSeed(): LiveSeed {
  const path = fileURLToPath(new URL("../.e2e-live.json", import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as LiveSeed;
}

test("Live console runs the judging loop with a capability judge", async ({ browser }) => {
  const seed = readSeed();
  const staffContext = await browser.newContext();
  const judgeContext = await browser.newContext();
  const staff = await staffContext.newPage();
  const judge = await judgeContext.newPage();

  try {
    await staff.goto("/login");
    await staff.getByLabel("用户名").fill("e2e-ops");
    await staff.getByLabel("密码").fill("e2e-ops-password");
    await staff.getByRole("button", { name: "登录" }).click();
    await expect(staff).toHaveURL(/\/ops$/);

    await staff.goto(`/live/${seed.activityId}`);
    await expect(staff.getByRole("heading", { name: seed.title, exact: true })).toBeVisible();

    await staff.getByRole("button", { name: "启动评分会话" }).click();
    await expect(staff.getByTestId("live-session-status")).toHaveText(/judging · rehearsal · running/);

    const round = staff.getByTestId("live-round-round-1");
    await round.getByRole("button", { name: "准备回合" }).click();
    await expect(round.getByRole("heading", { name: /round-1 · prepared/ })).toBeVisible();

    await round.getByRole("button", { name: "激活评委组" }).click();
    await expect(round.getByRole("heading", { name: /round-1 · scoring/ })).toBeVisible();
    await expect(round.getByText("seat-1 · judge-1")).toBeVisible();

    await round.getByRole("button", { name: "开表演" }).click();
    await expect(round.getByTestId("score-count-singer-a")).toHaveText("0/1");

    await staff.getByRole("button", { name: "生成评委入口链接" }).click();
    const link = await staff.getByLabel("评委入口链接").inputValue();
    expect(link).toContain(`/judge/${encodeURIComponent(seed.publicCode)}?capability=`);

    await judge.goto(link);
    await expect(judge.getByRole("heading", { name: seed.title, exact: true })).toBeVisible();
    await expect(judge.getByRole("heading", { name: "singer-a" })).toBeVisible();
    await judge.getByLabel(/演唱技巧/).fill("90");
    await judge.getByLabel(/舞台表现/).fill("92");
    await judge.getByLabel(/情感表达/).fill("91");
    await judge.getByRole("button", { name: "提交评分" }).click();
    await expect(judge.getByTestId("judge-submitted")).toContainText("singer-a");

    await expect(round.getByTestId("score-count-singer-a")).toHaveText("1/1", { timeout: 15_000 });

    await round.getByRole("button", { name: "锁表演" }).click();
    await expect(round.getByRole("cell", { name: "locked", exact: true })).toBeVisible();

    await round.getByRole("button", { name: "锁轮" }).click();
    await expect(round.getByRole("heading", { name: /round-1 · locked/ })).toBeVisible();

    await round.getByRole("button", { name: "生成排名" }).click();
    await expect(round.getByText(/RANKING · READY/)).toBeVisible();
    await expect(round.getByRole("cell", { name: "273.00", exact: true })).toBeVisible();

    await staff.getByRole("button", { name: "关闭会话" }).click();
    // Only a running session is part of the Live state; closing restores the start control.
    await expect(staff.getByRole("button", { name: "启动评分会话" })).toBeVisible();
  } finally {
    await staffContext.close();
    await judgeContext.close();
  }
});
