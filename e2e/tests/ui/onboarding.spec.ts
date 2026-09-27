import { expect, test } from "@playwright/test";
import { authFile, unique } from "../../lib/env.js";
import { tempPasswordFrom, waitForMail } from "../../lib/mailpit.js";

// Admin invites → invitee signs in with the emailed temporary password →
// forced to choose their own → lands on the dashboard → changes it again
// from settings → can sign in with the final password.
test("invited member onboarding, end to end", async ({ browser, request }) => {
  const email = `${unique("ui-invitee")}@example.test`;

  const adminCtx = await browser.newContext({ storageState: authFile("admin") });
  const admin = await adminCtx.newPage();
  await admin.goto("/invite");
  await admin.getByPlaceholder("Name", { exact: true }).fill("Una Invitee");
  await admin.getByPlaceholder("Email", { exact: true }).fill(email);
  await admin.locator("section", { hasText: "Invite a member" }).locator("select").selectOption("EDITOR");
  await admin.getByRole("button", { name: "Send invite", exact: true }).click();
  await expect(admin.getByText(`Invited ${email} — a temporary password was emailed to them.`)).toBeVisible();

  // Bulk invite on the same page: one new person, one existing member.
  const bulkEmail = `${unique("ui-bulk")}@example.test`;
  await admin.locator("textarea").fill(`Bulk Person, ${bulkEmail}, VIEWER\nExisting Member, viewer@vidforge.test, VIEWER`);
  await admin.getByRole("button", { name: "Send invites" }).click();
  await expect(admin.getByText(`✓ ${bulkEmail} — invited, temporary password emailed`)).toBeVisible();
  await expect(admin.locator("li", { hasText: "✕ viewer@vidforge.test" })).toContainText("already exists");
  await adminCtx.close();

  const temp = tempPasswordFrom((await waitForMail(request, email)).text);

  const inviteeCtx = await browser.newContext();
  const page = await inviteeCtx.newPage();
  await page.goto("/signup");
  await page.getByRole("button", { name: "Sign in", exact: true }).first().click();
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password", { exact: true }).fill(temp);
  await page.locator('form button[type="submit"]').click();

  await expect(page.getByText("You signed in with a temporary password.")).toBeVisible();
  await page.getByPlaceholder("New password (8+ characters)").fill("Invitee-ui-pass-1");
  await page.getByRole("button", { name: "Set new password" }).click();
  await page.waitForURL("/");
  await expect(page.getByRole("button", { name: /Una Invitee/ })).toContainText("EDITOR");
  await expect(page.getByRole("button", { name: "Upload video" })).toBeVisible();

  // Settings: profile + change password.
  await page.goto("/settings");
  await expect(page.getByText(email)).toBeVisible();
  await expect(page.getByText("EDITOR")).toBeVisible();
  await page.getByPlaceholder("Current password").fill("Invitee-ui-pass-1");
  await page.getByPlaceholder("New password (8+ characters)").fill("Invitee-ui-pass-2");
  await page.getByRole("button", { name: "Update password" }).click();
  await expect(page.getByText("Password updated.")).toBeVisible();

  // Sign out, then in with the final password.
  await page.goto("/");
  await page.getByRole("button", { name: /Una Invitee/ }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.goto("/signup");
  await page.getByRole("button", { name: "Sign in", exact: true }).first().click();
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password", { exact: true }).fill("Invitee-ui-pass-2");
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL("/");
  await expect(page.getByRole("button", { name: /Una Invitee/ })).toBeVisible();
  await inviteeCtx.close();
});
