"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { getToken, portalFetch, type HistoryEntry } from "@/lib/api";

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function HistoryPage() {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!getToken(orgSlug)) {
      window.location.href = `/${orgSlug}/login`;
      return;
    }
    let cancelled = false;
    void (async () => {
      const res = await portalFetch(orgSlug, `/v1/portal/history`);
      if (!res.ok || cancelled) return;
      setHistory((await res.json()).history ?? []);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [orgSlug]);

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-8">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold tracking-tight">Watch history</h2>
        <a href={`/${orgSlug}`} className="text-sm text-slate-400 hover:text-slate-200">
          ← Back to library
        </a>
      </div>

      {loaded && history.length === 0 && (
        <p className="text-sm text-slate-500">Nothing watched yet.</p>
      )}

      <div className="flex flex-col divide-y divide-slate-800">
        {history.map((h) => (
          <div key={h.assetId} className="flex items-center justify-between py-3">
            <div className="flex flex-col gap-0.5">
              <span className="text-sm text-slate-200">{h.title}</span>
              <span className="text-xs text-slate-500">
                Stopped at {formatDuration(h.positionSeconds)} · {new Date(h.updatedAt).toLocaleDateString()}
              </span>
            </div>
            {h.available ? (
              <a
                href={`/${orgSlug}/watch/${h.assetId}?job=${h.latestCompletedJobId ?? ""}`}
                className="rounded-md bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500"
              >
                Resume
              </a>
            ) : (
              <span className="text-xs text-slate-500">No longer available</span>
            )}
          </div>
        ))}
      </div>
    </main>
  );
}
