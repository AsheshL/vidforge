"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import {
  getToken,
  portalFetch,
  type LibraryAsset,
  type PageInfo,
  type ProgressEntry,
  type ThumbnailsResponse,
} from "@/lib/api";
import { continueWatchingIds } from "@/lib/library";

function Poster({ orgSlug, jobId }: { orgSlug: string; jobId: string | null }) {
  const [poster, setPoster] = useState<string | null>(null);

  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    void (async () => {
      const res = await portalFetch(orgSlug, `/v1/portal/jobs/${jobId}/thumbnails`);
      if (!res.ok || cancelled) return;
      const body = (await res.json()) as ThumbnailsResponse;
      if (!cancelled && body.thumbnails?.length) setPoster(body.thumbnails[0]);
    })();
    return () => {
      cancelled = true;
    };
  }, [orgSlug, jobId]);

  if (!poster) {
    return <div className="aspect-video w-full rounded-lg bg-slate-900" />;
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={poster} alt="" className="aspect-video w-full rounded-lg object-cover" />;
}

function AssetCard({ orgSlug, asset }: { orgSlug: string; asset: LibraryAsset }) {
  return (
    <a
      href={`/${orgSlug}/watch/${asset.assetId}?job=${asset.latestCompletedJobId ?? ""}`}
      className="flex flex-col gap-2"
    >
      <Poster orgSlug={orgSlug} jobId={asset.latestCompletedJobId} />
      <span className="truncate text-sm text-slate-200">{asset.title}</span>
    </a>
  );
}

export default function LibraryPage() {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const [assets, setAssets] = useState<LibraryAsset[]>([]);
  const [progress, setProgress] = useState<ProgressEntry[]>([]);
  const [pageInfo, setPageInfo] = useState<PageInfo>({ nextPageToken: "", totalCount: 0 });
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // Debounce the search box so typing doesn't fire a library fetch on every
  // keystroke (Finding 4) — the input itself stays bound to `q` so it feels
  // responsive; only the API call waits for typing to pause.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(timer);
  }, [q]);

  // Progress doesn't depend on the search query, so it's fetched once on
  // mount rather than on every debounced search (Finding 4).
  const refreshProgress = useCallback(async () => {
    const res = await portalFetch(orgSlug, `/v1/portal/progress`);
    if (res.ok) {
      setProgress((await res.json()).progress ?? []);
    }
  }, [orgSlug]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!getToken(orgSlug)) {
        window.location.href = `/${orgSlug}/login`;
        return;
      }
      const params = new URLSearchParams({ pageSize: "24", ...(debouncedQ ? { q: debouncedQ } : {}) });
      try {
        const res = await portalFetch(orgSlug, `/v1/portal/library?${params}`);
        if (cancelled) return;
        if (res.ok) {
          const data = await res.json();
          setAssets(data.assets ?? []);
          setPageInfo(data.pageInfo ?? { nextPageToken: "", totalCount: 0 });
        }
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgSlug, debouncedQ]);

  useEffect(() => {
    void refreshProgress();
  }, [refreshProgress]);

  async function loadMore() {
    if (!pageInfo.nextPageToken || loadingMore) return;
    setLoadingMore(true);
    try {
      const params = new URLSearchParams({
        pageSize: "24",
        pageToken: pageInfo.nextPageToken,
        ...(q ? { q } : {}),
      });
      const res = await portalFetch(orgSlug, `/v1/portal/library?${params}`);
      if (res.ok) {
        const data = await res.json();
        setAssets((prev) => [...prev, ...(data.assets ?? [])]);
        setPageInfo(data.pageInfo ?? { nextPageToken: "", totalCount: 0 });
      }
    } finally {
      setLoadingMore(false);
    }
  }

  const continuing = continueWatchingIds(assets, progress, 8);
  const continuingAssets = continuing
    .map((id) => assets.find((a) => a.assetId === id))
    .filter((a): a is LibraryAsset => !!a);

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-8 px-6 py-8">
      <input
        placeholder="Search titles…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        className="rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-500 focus:border-sky-500 focus:outline-none"
      />

      {continuingAssets.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-medium">Continue watching</h2>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {continuingAssets.map((a) => (
              <AssetCard key={a.assetId} orgSlug={orgSlug} asset={a} />
            ))}
          </div>
        </section>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">
          Library
          {pageInfo.totalCount > 0 && (
            <span className="ml-2 text-sm font-normal text-slate-500">
              {assets.length} of {pageInfo.totalCount}
            </span>
          )}
        </h2>
        {!loaded ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : assets.length === 0 ? (
          <p className="text-sm text-slate-500">Nothing here yet.</p>
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {assets.map((a) => (
              <AssetCard key={a.assetId} orgSlug={orgSlug} asset={a} />
            ))}
          </div>
        )}
        {pageInfo.nextPageToken && (
          <button
            onClick={() => void loadMore()}
            disabled={loadingMore}
            className="self-center rounded-md border border-slate-700 px-4 py-1.5 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-50"
          >
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        )}
      </section>
    </main>
  );
}
