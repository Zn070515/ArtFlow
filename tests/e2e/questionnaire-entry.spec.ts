import { expect, test } from "@playwright/test";

// The repository's browser suite is a read-only smoke against an already-running service:
// it does not seed data or log in. That bounds what can be asserted here to the entry
// boundary of the questionnaire route. The fuller P4 gate -- autosave, condition
// show/hide, file upload, submit validation, and the closed/supplement states -- is
// covered by the Django tests in questionnaire/test_form.py; exercising it in a browser
// needs a seeded activity with a frozen questionnaire, which this harness does not build.
test.describe("questionnaire entry boundary", () => {
  test("an anonymous visitor is sent to a login page rather than the form", async ({ page }) => {
    const response = await page.goto("/questionnaire/000000/");

    // Not a 500 and not the form: an unknown activity and a refused one both end up at
    // the login boundary, and neither leaks whether the activity exists.
    expect(response?.status()).toBeLessThan(500);
    expect(new URL(page.url()).pathname.startsWith("/login")).toBe(true);
    await expect(page.getByRole("heading", { name: "选择登录入口" })).toBeVisible();
  });

  test("the autosave endpoint answers a POST without a session with a redirect, not a write", async ({
    page,
    request,
  }) => {
    const response = await request.post("/questionnaire/000000/autosave/", {
      data: { answers: { name: "anonymous" } },
    });
    expect(response.status()).toBeLessThan(500);
    expect([302, 403]).toContain(response.status());
    await page.goto("/questionnaire/000000/");
  });
});

for (const viewport of [
  { width: 375, height: 667 },
  { width: 390, height: 844 },
  { width: 412, height: 915 },
]) {
  test.describe(`questionnaire entry at ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport });

    test("the login boundary does not scroll sideways", async ({ page }) => {
      await page.goto("/questionnaire/000000/");
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(1);
    });
  });
}
