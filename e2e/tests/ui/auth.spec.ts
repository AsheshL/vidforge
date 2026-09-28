import { expect, test } from "@playwright/test";
import { unique } from "../../lib/env.js";

// No stored session: these start signed out.
test.describe("sign up, sign out, sign in", () => {
  test("signed-out visitors are pointed to sign in", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
    await expect(page.getByText("Sign in to see your jobs.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Upload video" })).toHaveCount(0);
  });

  test("a new user signs up into a fresh org, signs out and back in", async ({ page }) => {
    const email = `${unique("e2e-ui-signup")}@example.test`;
    const password = "Ui-signup-pass-1";

    await page.goto("/signup");
    await page.getByPlaceholder("Display name").fill("UI Founder");
    await page.getByPlaceholder("Organization name (optional)").fill(unique("ui-org"));
    await page.getByPlaceholder("Email").fill(email);
    await page.getByPlaceholder("Password (8+ characters)").fill(password);
    await page.getByRole("button", { name: "Create account" }).click();

    await page.waitForURL("/");
    const menu = page.getByRole("button", { name: /UI Founder/ });
    await expect(menu).toContainText("OWNER");
    // A brand-new org starts empty.
    await expect(page.getByText("No assets yet — upload a video to get started.")).toBeVisible();

    await menu.click();
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();

    await page.goto("/signup");
    await page.getByRole("button", { name: "Sign in", exact: true }).first().click();
    await page.getByPlaceholder("Email").fill(email);
    await page.getByPlaceholder("Password", { exact: true }).fill("Wrong-password-9");
    await page.locator('form button[type="submit"]').click();
    await expect(page.locator("form").locator("p.text-rose-400")).toBeVisible();

    await page.getByPlaceholder("Password", { exact: true }).fill(password);
    await page.locator('form button[type="submit"]').click();
    await page.waitForURL("/");
    await expect(page.getByRole("button", { name: /UI Founder/ })).toBeVisible();
  });
});
