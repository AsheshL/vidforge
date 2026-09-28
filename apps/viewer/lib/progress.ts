export interface ProgressTick {
  atMs: number;
  forced?: boolean;
}

// Throttles PUT /v1/portal/progress/:assetId to roughly once per
// thresholdSeconds — the video element's timeupdate event fires ~4x/second,
// far too often to call the API on every tick (plan Global Constraints /
// Review Focus #5). `forced` bypasses the threshold for pause/unload, so a
// short viewing session still gets its final position saved.
export function shouldReportProgress(
  last: { atMs: number } | null,
  next: ProgressTick,
  thresholdSeconds: number,
): boolean {
  if (next.forced) return true;
  if (!last) return true;
  return next.atMs - last.atMs >= thresholdSeconds * 1000;
}
