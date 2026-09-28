import { describe, expect, it } from "vitest";
import { continueWatchingIds } from "./library";
import type { LibraryAsset, ProgressEntry } from "./api";

const assets: LibraryAsset[] = [
  { assetId: "a1", title: "One", durationSeconds: 100, latestCompletedJobId: "j1" },
  { assetId: "a2", title: "Two", durationSeconds: 100, latestCompletedJobId: "j2" },
  { assetId: "a3", title: "Three", durationSeconds: 100, latestCompletedJobId: "j3" },
];

describe("continueWatchingIds", () => {
  it("returns loaded assets with progress, most recently updated first", () => {
    const progress: ProgressEntry[] = [
      { assetId: "a2", positionSeconds: 10, updatedAt: "2026-01-01T00:00:00.000Z" },
      { assetId: "a1", positionSeconds: 20, updatedAt: "2026-01-02T00:00:00.000Z" },
    ];
    expect(continueWatchingIds(assets, progress, 10)).toEqual(["a1", "a2"]);
  });

  it("ignores progress for assets not in the currently loaded page", () => {
    const progress: ProgressEntry[] = [
      { assetId: "not-loaded", positionSeconds: 5, updatedAt: "2026-01-01T00:00:00.000Z" },
      { assetId: "a3", positionSeconds: 5, updatedAt: "2026-01-01T00:00:00.000Z" },
    ];
    expect(continueWatchingIds(assets, progress, 10)).toEqual(["a3"]);
  });

  it("respects the limit", () => {
    const progress: ProgressEntry[] = [
      { assetId: "a1", positionSeconds: 1, updatedAt: "2026-01-01T00:00:00.000Z" },
      { assetId: "a2", positionSeconds: 1, updatedAt: "2026-01-02T00:00:00.000Z" },
      { assetId: "a3", positionSeconds: 1, updatedAt: "2026-01-03T00:00:00.000Z" },
    ];
    expect(continueWatchingIds(assets, progress, 2)).toEqual(["a3", "a2"]);
  });
});
