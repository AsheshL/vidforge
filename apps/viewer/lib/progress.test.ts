import { describe, expect, it } from "vitest";
import { shouldReportProgress } from "./progress";

describe("shouldReportProgress", () => {
  it("reports on the very first tick (no prior report)", () => {
    expect(shouldReportProgress(null, { atMs: 1_000 }, 10)).toBe(true);
  });

  it("does not report again before the threshold elapses", () => {
    expect(shouldReportProgress({ atMs: 1_000 }, { atMs: 1_000 + 5_000 }, 10)).toBe(false);
  });

  it("reports again once the threshold elapses", () => {
    expect(shouldReportProgress({ atMs: 1_000 }, { atMs: 1_000 + 10_000 }, 10)).toBe(true);
  });

  it("always reports when forced (pause/unload), regardless of elapsed time", () => {
    expect(shouldReportProgress({ atMs: 1_000 }, { atMs: 1_500, forced: true }, 10)).toBe(true);
  });
});
