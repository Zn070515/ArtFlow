import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

function readSeed(): { readonly publicCode: string } {
  const path = fileURLToPath(new URL("../.e2e-legacy.json", import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as { readonly publicCode: string };
}

test("imported v1 results render on the public results page", async ({ page }) => {
  const seed = readSeed();
  await page.goto(`/results/${seed.publicCode}`);

  await expect(page.getByRole("heading", { name: "2025 院十佳", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "2025 院十佳 · 正式赛果" })).toBeVisible();
  await expect(page.getByText("legacy-user:1").first()).toBeVisible();
  await expect(page.getByText("91.50").first()).toBeVisible();
  await expect(page.getByText("冠军")).toBeVisible();
});
