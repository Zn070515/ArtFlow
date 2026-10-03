import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const fixturePath = process.env.PLAYWRIGHT_LIVE_TICKET_FIXTURE_PATH;
const staffAccessKey = process.env.ARTFLOW_E2E_STAFF_ACCESS_KEY;

test("one live URL updates, checks in a ticket, and admits a ballot", async ({ browser }) => {
  if (!fixturePath || !staffAccessKey) {
    throw new Error(
      "PLAYWRIGHT_LIVE_TICKET_FIXTURE_PATH and ARTFLOW_E2E_STAFF_ACCESS_KEY are required.",
    );
  }
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
    public_code?: unknown;
    vote_session_id?: unknown;
    credential?: unknown;
    staff_username?: unknown;
    staff_password?: unknown;
  };
  if (
    typeof fixture.public_code !== "string" ||
    typeof fixture.vote_session_id !== "number" ||
    typeof fixture.credential !== "string" ||
    typeof fixture.staff_username !== "string" ||
    typeof fixture.staff_password !== "string"
  ) {
    throw new Error("Live/Ticket browser fixture is incomplete.");
  }

  const viewerContext = await browser.newContext();
  const staffContext = await browser.newContext();
  try {
    const viewer = await viewerContext.newPage();
    const staff = await staffContext.newPage();
    const livePath = `/e/${fixture.public_code}/live/`;

    await viewer.goto(livePath);
    await expect(viewer.locator("[data-live-waiting]")).toBeVisible();

    await staff.goto("/login/staff/");
    await staff.getByLabel("用户名").fill(fixture.staff_username);
    await staff.getByLabel("密码").fill(fixture.staff_password);
    await staff.getByLabel("工作人员密钥").fill(staffAccessKey);
    await staff.getByRole("button", { name: "登录" }).click();
    await expect(staff).toHaveURL(/\/staff\/$/);

    await staff.goto(`/staff/vote-sessions/${fixture.vote_session_id}/`);
    await staff.getByRole("button", { name: "开启投票" }).click();
    await expect(staff.getByText("投票中")).toBeVisible();
    await expect(viewer.locator("[data-live-vote-link]")).toBeVisible({ timeout: 10000 });

    await staff.goto("/staff/tickets/check-in-page/");
    await staff
      .locator("[data-ticket-check-in-form] input[name=secret]")
      .fill(fixture.credential);
    await staff.getByRole("button", { name: "确认检票" }).click();
    await expect(staff.locator("[data-ticket-check-in-status]")).toHaveText(/检票成功/);

    await viewer.goto(`/tickets/scan/#${encodeURIComponent(fixture.credential)}`);
    await expect(viewer.locator("[data-ticket-scan-status]")).toHaveText(/已完成现场检票/);
    await viewer.goto(`/voting/${fixture.vote_session_id}/`);
    await expect(viewer.locator("[data-vote-cast]")).toBeVisible();
    await viewer.locator("[data-vote-option]").first().check();
    await viewer.getByRole("button", { name: "提交投票" }).click();
    await expect(viewer.getByRole("heading", { name: "投票成功" })).toBeVisible();
    await expect(viewer.getByRole("link", { name: "返回现场页面" })).toHaveAttribute(
      "href",
      livePath,
    );
  } finally {
    await viewerContext.close();
    await staffContext.close();
  }
});
