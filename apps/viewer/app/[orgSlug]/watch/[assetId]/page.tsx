"use client";

import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { Player } from "@/components/Player";
import { getToken, portalFetch, type ProgressEntry } from "@/lib/api";

export default function WatchPage() {
  const { orgSlug, assetId } = useParams<{ orgSlug: string; assetId: string }>();
  const searchParams = useSearchParams();
  const jobId = searchParams.get("job");
  const [startPosition, setStartPosition] = useState<number | null>(null);

  useEffect(() => {
    if (!getToken(orgSlug)) {
      window.location.href = `/${orgSlug}/login`;
      return;
    }
    if (!jobId) return;
    let cancelled = false;
    void (async () => {
      const res = await portalFetch(orgSlug, `/v1/portal/progress`);
      if (!res.ok || cancelled) return;
      const rows = ((await res.json()).progress ?? []) as ProgressEntry[];
      const mine = rows.find((r) => r.assetId === assetId);
      if (!cancelled) setStartPosition(mine?.positionSeconds ?? 0);
    })();
    return () => {
      cancelled = true;
    };
  }, [orgSlug, assetId, jobId]);

  if (!jobId) {
    return (
      <main className="mx-auto flex max-w-4xl flex-col gap-4 px-6 py-12 text-center">
        <p className="text-sm text-slate-400">This video is no longer available.</p>
        <a href={`/${orgSlug}`} className="text-sm text-sky-400 hover:text-sky-300">
          ← Back to library
        </a>
      </main>
    );
  }

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-6 px-6 py-8">
      <a href={`/${orgSlug}`} className="text-sm text-slate-400 hover:text-slate-200">
        ← Back to library
      </a>
      {startPosition !== null && (
        <Player orgSlug={orgSlug} assetId={assetId} jobId={jobId} startPositionSeconds={startPosition} />
      )}
    </main>
  );
}
