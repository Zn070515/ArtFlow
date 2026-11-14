import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

interface ModeSeed {
  readonly modeActivityId: string;
  readonly modePublicCode: string;
  readonly modeTitle: string;
}

function readSeed(): ModeSeed {
  const path = fileURLToPath(new URL("../.e2e-live.json", import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as ModeSeed;
}

test("rehearses, resets, then runs the same round formally", async ({ browser }) => {
  const seed = readSeed();
  const staffContext = await browser.newContext();
  const rehearsalJudgeContext = await browser.newContext();
  const formalJudgeContext = await browser.newContext();
  const staff = await staffContext.newPage();
  const rehearsalJudge = await rehearsalJudgeContext.newPage();
  const formalJudge = await formalJudgeContext.newPage();

  try {
    await staff.goto("/login");
    await staff.getByLabel("用户名").fill("e2e-ops");
    await staff.getByLabel("密码").fill("e2e-ops-password");
    await staff.getByRole("button", { name: "登录" }).click();
    await expect(staff).toHaveURL(/\/workspace$/);

    await staff.goto(`/live/${seed.modeActivityId}`);
    await expect(staff.getByRole("heading", { name: seed.modeTitle, exact: true })).toBeVisible();

    await staff.getByRole("button", { name: "启动评分会话" }).click();
    await expect(staff.getByTestId("live-session-status")).toHaveText(/评分会话 · 彩排 · 运行中/);

    const round = staff.getByTestId("live-round-round-1");
    await round.getByRole("button", { name: "准备回合" }).click();
    await expect(round.getByRole("heading", { name: /round-1 · 已准备/ })).toBeVisible();
    await round.getByRole("button", { name: "激活评委组" }).click();
    await expect(round.getByRole("heading", { name: /round-1 · 评分中/ })).toBeVisible();
    await round.getByRole("button", { name: "开表演" }).click();
    await expect(round.getByTestId("score-count-singer-a")).toHaveText("0/1");

    await staff.getByRole("button", { name: "生成评委入口链接" }).click();
    const rehearsalLink = await staff.getByLabel("评委入口链接").inputValue();
    await rehearsalJudge.goto(rehearsalLink);
    await expect(rehearsalJudge.getByRole("heading", { name: "林晓" })).toBeVisible({ timeout: 15_000 });
    await rehearsalJudge.getByLabel(/演唱技巧/).fill("90");
    await rehearsalJudge.getByLabel(/舞台表现/).fill("92");
    await rehearsalJudge.getByLabel(/情感表达/).fill("91");
    await rehearsalJudge.getByRole("button", { name: "提交评分" }).click();
    await expect(rehearsalJudge.getByTestId("judge-submitted")).toContainText("林晓");
    await expect(round.getByTestId("score-count-singer-a")).toHaveText("1/1", { timeout: 15_000 });

    await round.getByRole("button", { name: "锁表演" }).click();
    await round.getByRole("button", { name: "锁轮" }).click();
    await expect(round.getByRole("heading", { name: /round-1 · 已锁定/ })).toBeVisible();
    await round.getByRole("button", { name: "生成排名" }).click();
    await expect(round.getByRole("table", { name: "当前排名"})).toBeVisible();
    await expect(round.getByRole("cell", { name: "273.00", exact: true })).toBeVisible();

    await round.getByRole("button", { name: "重置排练" }).click();
    const resetDialog = staff.getByRole("dialog", { name: "清空排练数据？" });
    await resetDialog.getByRole("button", { name: "清空并回到准备状态" }).click();
    await expect(round.getByRole("heading", { name: /round-1 · 已准备/ })).toBeVisible();
    await expect(round.getByTestId("score-count-singer-a")).toHaveCount(0);
    await expect(round.getByRole("table", { name: /当前排名/ })).toHaveCount(0);

    await staff.getByRole("button", { name: "关闭会话" }).click();
    await staff.getByRole("dialog").getByRole("button", { name: "关闭会话" }).click();
    await staff.getByLabel("评分模式").selectOption("formal");
    await staff.getByRole("button", { name: "启动评分会话" }).click();
    await expect(staff.getByTestId("live-session-status")).toHaveText(/评分会话 · 正式 · 运行中/);

    await round.getByRole("button", { name: "激活评委组" }).click();
    await expect(round.getByRole("heading", { name: /round-1 · 评分中/ })).toBeVisible();
    await round.getByRole("button", { name: "开表演" }).click();
    await expect(round.getByTestId("score-count-singer-a")).toHaveText("0/1");

    await staff.getByRole("button", { name: "生成评委入口链接" }).click();
    const regenerateDialog = staff.getByRole("dialog", { name: "重新生成评委会入口链接？" });
    if (await regenerateDialog.isVisible()) {
      await regenerateDialog.getByRole("button", { name: "重新生成" }).click();
    }
    await expect(staff.getByLabel("评委入口链接")).toBeVisible();
    const formalLink = await staff.getByLabel("评委入口链接").inputValue();
    await formalJudge.goto(formalLink);
    await expect(formalJudge.getByRole("heading", { name: "林晓" })).toBeVisible({ timeout: 15_000 });
    await formalJudge.getByLabel(/演唱技巧/).fill("80");
    await formalJudge.getByLabel(/舞台表现/).fill("80");
    await formalJudge.getByLabel(/情感表达/).fill("80");
    await formalJudge.getByRole("button", { name: "提交评分" }).click();
    await expect(formalJudge.getByTestId("judge-submitted")).toContainText("林晓");
    await expect(round.getByTestId("score-count-singer-a")).toHaveText("1/1", { timeout: 15_000 });

    await round.getByRole("button", { name: "锁表演" }).click();
    await round.getByRole("button", { name: "锁轮" }).click();
    await expect(round.getByRole("heading", { name: /round-1 · 已锁定/ })).toBeVisible();
    await round.getByRole("button", { name: "生成排名" }).click();
    await expect(round.getByRole("cell", { name: "240.00", exact: true })).toBeVisible();
  } finally {
    await staffContext.close();
    await rehearsalJudgeContext.close();
    await formalJudgeContext.close();
  }
});
