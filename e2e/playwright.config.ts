import { defineConfig, devices } from "@playwright/test";
import { WEB_URL } from "./lib/env.js";

// End-to-end suite against a running stack (see README "End-to-end tests").
// Not part of `turbo test`: it needs the full dev stack, ffmpeg and Mailpit.
export default defineConfig({
  testDir: "./tests",
  globalSetup: "./global-setup.ts",
  // Tests share one seeded database and run real transcodes; serial keeps
  // runs deterministic and the worker queue short.
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: WEB_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "api", testDir: "./tests/api" },
    {
      name: "ui",
      testDir: "./tests/ui",
      use: {
        ...devices["Desktop Chrome"],
        // Playwright's bundled Chromium has no H.264/AAC decoders, so the
        // player can't actually play there. E2E_BROWSER_CHANNEL=chrome runs
        // the UI project in installed Google Chrome, which can.
        ...(process.env.E2E_BROWSER_CHANNEL ? { channel: process.env.E2E_BROWSER_CHANNEL } : {}),
      },
    },
  ],
});
