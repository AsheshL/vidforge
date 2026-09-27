import { expect, test } from "@playwright/test";
import { Gateway } from "../../lib/api.js";
import { authFile } from "../../lib/env.js";

test.use({ storageState: authFile("viewer") });

let jobId: string;
test.beforeAll(async () => {
  const editor = await Gateway.standalone("editor");
  ({ jobId } = await editor.seedCompleted()); // 720p + 360p with thumbnails
  await editor.dispose();
});

test("watch page streams HLS and scrubs by thumbnail", async ({ page }) => {
  const hls: { url: string; status: number }[] = [];
  page.on("response", (r) => {
    if (/\.m3u8|\.ts\?/.test(r.url())) hls.push({ url: r.url(), status: r.status() });
  });

  await page.goto(`/watch/${jobId}`);
  await expect(page.getByText(`Playing job ${jobId.slice(-8)}`)).toBeVisible();
  await expect.poll(() => hls.length).toBeGreaterThanOrEqual(2);

  const h264 = await page.evaluate(() =>
    typeof MediaSource !== "undefined" &&
    MediaSource.isTypeSupported('video/mp4; codecs="avc1.640028,mp4a.40.2"'),
  );
  if (!h264) {
    // Playwright's bundled Chromium ships without H.264/AAC. Everything up
    // to decoding is still checked; run with E2E_BROWSER_CHANNEL=chrome to
    // cover actual playback.
    test.info().annotations.push({ type: "limited", description: "browser lacks H.264/AAC; playback not asserted" });
    expect(hls.every((r) => r.status === 200), JSON.stringify(hls)).toBe(true);
    expect(hls.some((r) => r.url.includes("master.m3u8"))).toBe(true);
    expect(hls.some((r) => /\.ts\?/.test(r.url))).toBe(true);
    return;
  }

  const video = page.locator("video");
  await video.evaluate((v: HTMLVideoElement) => {
    v.muted = true;
    return v.play();
  });
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 20_000 }).toBeGreaterThan(1);
  expect(await video.evaluate((v: HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(0);

  // Quality picker lists both renditions and switches level.
  await expect(page.getByRole("button", { name: "Auto" })).toBeVisible();
  await page.getByRole("button", { name: "360p" }).click();
  await expect(page.getByRole("button", { name: "360p" })).toHaveClass(/bg-sky-600/);

  // Thumbnail strip seeks: thumbnail i of n jumps to i/n of the duration.
  const thumbs = page.getByTitle(/Seek to \d+ of \d+/);
  const n = await thumbs.count();
  expect(n).toBeGreaterThan(0);
  await thumbs.nth(n - 1).click();
  const duration = await video.evaluate((v: HTMLVideoElement) => v.duration);
  await expect
    .poll(async () => Math.abs((await video.evaluate((v: HTMLVideoElement) => v.currentTime)) - ((n - 1) / n) * duration))
    .toBeLessThan(1.5);
});

test("unknown job shows an error, not a broken player", async ({ page }) => {
  await page.goto("/watch/does-not-exist");
  await expect(page.getByText(/Playback error|error/i)).toBeVisible();
});
