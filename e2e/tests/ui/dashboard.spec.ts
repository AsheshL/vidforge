import { expect, test, type Page } from "@playwright/test";
import { authFile, unique } from "../../lib/env.js";
import { makeTestVideo } from "../../lib/media.js";

const assetRow = (page: Page, title: string) =>
  page.locator("table").first().locator("tbody tr", { hasText: title });
const jobRows = (page: Page, title: string) => page.locator("table").nth(1).locator("tbody tr", { hasText: title });

test.describe("dashboard as an editor", () => {
  test.use({ storageState: authFile("editor") });

  test("upload → transcode → live progress → play, poster, re-run, delete", async ({ page }) => {
    test.setTimeout(240_000);
    const title = `${unique("e2e-ui")}.mp4`;
    const file = makeTestVideo(title, { seconds: 6 });

    await page.goto("/");
    await expect(page.getByRole("heading", { name: /Assets/ })).toBeVisible();

    // Upload through the real tus client in the page.
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Upload video" }).click();
    await (await chooser).setFiles(file);
    await expect(assetRow(page, title)).toContainText("UPLOADED", { timeout: 30_000 });

    // Transcode with a non-default preset.
    await assetRow(page, title).getByRole("button", { name: "Transcode" }).click();
    await assetRow(page, title).locator("select").selectOption({ label: "480p only" });
    await assetRow(page, title).getByRole("button", { name: "Start" }).click();

    // The jobs board picks it up and streams progress to completion.
    await expect(jobRows(page, title)).toHaveCount(1);
    await expect(jobRows(page, title).first()).toContainText("Completed", { timeout: 120_000 });
    await expect(jobRows(page, title).first()).toContainText("100%");

    // Asset row now offers playback and shows a poster thumbnail.
    await page.reload();
    await expect(assetRow(page, title)).toContainText("READY");
    await expect(assetRow(page, title).getByRole("link", { name: "▶ Play" })).toBeVisible();
    await expect
      .poll(() => assetRow(page, title).locator("img").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
      .toBe(true);

    // Re-run the completed job with another preset.
    await jobRows(page, title).first().getByRole("button", { name: "Re-run" }).click();
    await jobRows(page, title).first().locator("select").selectOption({ label: "720p + 360p" });
    await jobRows(page, title).first().getByRole("button", { name: "Re-run" }).click();
    await expect(jobRows(page, title)).toHaveCount(2);
    await expect(jobRows(page, title).first()).toContainText("Completed", { timeout: 120_000 });

    // Delete one of them.
    await jobRows(page, title).last().getByRole("button", { name: "Delete" }).click();
    await expect(jobRows(page, title)).toHaveCount(1);
  });

  test("seed test video creates a job that completes", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /Transcode jobs/ })).toBeVisible();
    const seeded = page.waitForResponse((r) => r.url().endsWith("/v1/dev/seed") && r.request().method() === "POST");
    await page.getByRole("button", { name: "Seed test video" }).click();
    const { storageKey } = await (await seeded).json();
    // Seeded assets are titled "Seed video <id>", id from uploads/seed-<id>.mp4.
    const title = `Seed video ${/seed-(\w+)\.mp4$/.exec(storageKey)![1]}`;
    await expect(jobRows(page, title)).toHaveCount(1);
    await expect(jobRows(page, title)).toContainText("Completed", { timeout: 120_000 });
  });
});

test.describe("dashboard as a viewer", () => {
  test.use({ storageState: authFile("viewer") });

  test("sees assets and jobs but no editing controls", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /Assets/ })).toBeVisible();
    await expect(page.getByRole("link", { name: "▶ Play" }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Upload video" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Transcode" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Re-run" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Delete" })).toHaveCount(0);

    // No admin links in the user menu.
    await page.getByRole("button", { name: /VIEWER/ }).click();
    await expect(page.getByRole("link", { name: "Settings" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Organization" })).toHaveCount(0);
  });
});
