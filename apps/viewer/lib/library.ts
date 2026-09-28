import type { LibraryAsset, ProgressEntry } from "./api";

export function continueWatchingIds(
  assets: LibraryAsset[],
  progress: ProgressEntry[],
  limit: number,
): string[] {
  const loaded = new Set(assets.map((a) => a.assetId));
  return progress
    .filter((p) => loaded.has(p.assetId))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit)
    .map((p) => p.assetId);
}
