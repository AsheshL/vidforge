import { expect, test } from "@playwright/test";
import { Gateway } from "../../lib/api.js";
import { authFile, unique } from "../../lib/env.js";

test.describe("organization page as an admin", () => {
  test.use({ storageState: authFile("admin") });

  test("user menu links to org admin pages", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /ADMIN/ }).click();
    await expect(page.getByRole("link", { name: "Organization" })).toBeVisible();
    await page.getByRole("link", { name: "Invite members" }).click();
    await expect(page.getByRole("heading", { name: "Invite members" })).toBeVisible();
  });

  test("members: change a role and see it in the audit log", async ({ page, request }) => {
    const target = await Gateway.as(request, "viewer2");
    try {
      await page.goto("/org");
      const row = page.locator("tr", { hasText: "viewer2@vidforge.test" });
      await expect(row).toBeVisible();
      // Can't change your own role.
      await expect(page.locator("tr", { hasText: "admin@vidforge.test" }).locator("select")).toBeDisabled();

      await row.locator("select").selectOption("EDITOR");
      await expect(row.locator("select")).toHaveValue("EDITOR");
      await expect.poll(async () => (await Gateway.as(request, "viewer2")).session.user.role).toBe(2);
      // The audit log records it: action, user/<last 8 of id>, new role.
      const audit = page.locator("tr", { hasText: "user.assign_role" }).filter({
        hasText: `user/${target.session.user.userId.slice(-8)}`,
      });
      await expect(audit.filter({ hasText: '"role":"EDITOR"' }).first()).toBeVisible();
    } finally {
      const admin = await Gateway.as(request, "admin");
      await admin.post(`/v1/org/members/${target.session.user.userId}/role`, { role: "VIEWER" });
    }
  });

  test("API keys: create shows the secret once, then revoke", async ({ page }) => {
    const name = unique("ui-key");
    await page.goto("/org");
    await page.getByPlaceholder("e.g. CI pipeline").fill(name);
    await page.locator("section", { hasText: "Create API key" }).locator("select").selectOption("EDITOR");
    await page.getByRole("button", { name: "Create key" }).click();
    await expect(page.getByText("API key created")).toBeVisible();
    await expect(page.locator("code", { hasText: "vfk_" })).toBeVisible();
    await page.getByText("I've saved it — dismiss").click();
    await expect(page.locator("code", { hasText: "vfk_" })).toHaveCount(0);

    const row = page.locator("tr", { hasText: name });
    await expect(row).toContainText("Active");
    await row.getByRole("button", { name: "Revoke" }).click();
    await expect(row).toContainText("Revoked");
  });

  test("webhooks: add with chosen events, secret shown once, delete", async ({ page }) => {
    const url = `https://example.com/${unique("ui-hook")}`;
    await page.goto("/org");
    await page.getByPlaceholder("https://example.com/vidforge-webhook").fill(url);
    await page.getByLabel("Retrying").check();
    await page.getByLabel("Failed").uncheck();
    await page.getByRole("button", { name: "Add webhook" }).click();
    await expect(page.getByText("Webhook created")).toBeVisible();
    await expect(page.locator("code", { hasText: /^whsec_[0-9a-f]{48}$/ })).toBeVisible();

    const row = page.locator("tr", { hasText: url });
    await expect(row).toContainText("job.completed");
    await expect(row).toContainText("job.retrying");
    await expect(row).not.toContainText("job.failed");
    await expect(row).toContainText("Active");
    await row.getByRole("button", { name: "Delete" }).click();
    await expect(row).toHaveCount(0);
  });
});

test.describe("organization page as a viewer", () => {
  test.use({ storageState: authFile("viewer") });

  test("every admin panel is gated", async ({ page }) => {
    await page.goto("/org");
    await expect(page.getByText("Only org admins can view this page.")).toBeVisible();
    await expect(page.getByText("Only org admins can manage API keys.")).toBeVisible();
    await expect(page.getByText("Only org admins can manage webhooks.")).toBeVisible();
  });
});
