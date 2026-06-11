"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Upload } from "tus-js-client";
import { GATEWAY_URL, authHeaders, getStoredUser, getToken, type Asset } from "@/lib/api";

const STATUS_COLORS: Record<Asset["status"], string> = {
  UPLOADING: "text-amber-400",
  UPLOADED: "text-sky-400",
  PROCESSING: "text-sky-400",
  READY: "text-emerald-400",
  FAILED: "text-rose-400",
  ARCHIVED: "text-slate-500",
};

function formatBytes(n: number | null): string {
  if (n === null) return "—";
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function AssetsBoard() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [authed, setAuthed] = useState(false);
  const [canEdit, setCanEdit] = useState(false);
  const [uploading, setUploading] = useState<{ name: string; percent: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    if (!getToken()) return;
    const res = await fetch(`${GATEWAY_URL}/v1/assets`, { cache: "no-store", headers: authHeaders() });
    if (res.ok) {
      setAuthed(true);
      setAssets((await res.json()).assets ?? []);
    }
  }, []);

  useEffect(() => {
    const me = getStoredUser();
    setCanEdit(me?.role === "EDITOR" || me?.role === "ADMIN" || me?.role === "OWNER");
    void refresh();
  }, [refresh]);

  function startUpload(file: File) {
    setError(null);
    setUploading({ name: file.name, percent: 0 });
    const upload = new Upload(file, {
      endpoint: `${GATEWAY_URL}/v1/uploads`,
      headers: authHeaders(),
      metadata: { filename: file.name, filetype: file.type },
      onProgress: (sent, total) =>
        setUploading({ name: file.name, percent: Math.round((sent / total) * 100) }),
      onError: (err) => {
        setError(`upload failed: ${err.message}`);
        setUploading(null);
      },
      onSuccess: async () => {
        // The unguessable key in the upload URL is the claim ticket.
        const uploadKey = upload.url?.split("/").pop();
        const res = await fetch(`${GATEWAY_URL}/v1/assets/register`, {
          method: "POST",
          headers: { "content-type": "application/json", ...authHeaders() },
          body: JSON.stringify({ uploadKey, title: file.name }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          setError(typeof body?.error === "string" ? body.error : "failed to register upload");
        }
        setUploading(null);
        void refresh();
      },
    });
    upload.start();
  }

  async function transcode(asset: Asset) {
    setError(null);
    const res = await fetch(`${GATEWAY_URL}/v1/assets/${asset.assetId}/transcode`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        sourceStorageKey: asset.sourceStorageKey,
        renditions: [
          { name: "720p", width: 1280, height: 720, videoBitrateKbps: 2500, audioBitrateKbps: 128 },
          { name: "360p", width: 640, height: 360, videoBitrateKbps: 800, audioBitrateKbps: 96 },
        ],
        hlsSegmentSeconds: 6,
        generateThumbnails: true,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(typeof body?.error === "string" ? body.error : `transcode failed: ${res.status}`);
      return;
    }
    await refresh();
    // Let the jobs board pick up the new job immediately.
    window.dispatchEvent(new Event("vidforge:jobs-changed"));
  }

  if (!authed) return null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium">Assets</h2>
        {canEdit && (
          <div className="flex items-center gap-3">
            {uploading && (
              <span className="text-xs text-slate-400">
                {uploading.name} — {uploading.percent}%
              </span>
            )}
            <input
              ref={fileInput}
              type="file"
              accept="video/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) startUpload(file);
                e.target.value = "";
              }}
            />
            <button
              onClick={() => fileInput.current?.click()}
              disabled={!!uploading}
              className="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
            >
              {uploading ? "Uploading…" : "Upload video"}
            </button>
          </div>
        )}
      </div>

      {error && <p className="text-xs text-rose-400">{error}</p>}

      <div className="overflow-hidden rounded-lg border border-slate-800">
        <table className="w-full text-sm">
          <thead className="bg-slate-900 text-left text-slate-400">
            <tr>
              <th className="px-4 py-2.5 font-medium">Title</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
              <th className="px-4 py-2.5 font-medium">Size</th>
              <th className="px-4 py-2.5 font-medium">Duration</th>
              <th className="px-4 py-2.5 font-medium"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {assets.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-slate-500">
                  No assets yet{canEdit ? " — upload a video to get started." : "."}
                </td>
              </tr>
            )}
            {assets.map((a) => (
              <tr key={a.assetId} className="bg-slate-950">
                <td className="max-w-64 truncate px-4 py-3 text-slate-200">{a.title}</td>
                <td className={`px-4 py-3 font-medium ${STATUS_COLORS[a.status]}`}>{a.status}</td>
                <td className="px-4 py-3 text-xs text-slate-400">{formatBytes(a.sourceBytes)}</td>
                <td className="px-4 py-3 text-xs text-slate-400">
                  {a.durationSeconds ? `${Math.round(a.durationSeconds)}s` : "—"}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-1.5">
                    {a.latestCompletedJobId && (
                      <a
                        href={`/watch/${a.latestCompletedJobId}`}
                        className="rounded bg-slate-800 px-2 py-1 text-xs font-medium text-sky-400 hover:bg-slate-700"
                      >
                        ▶ Play
                      </a>
                    )}
                    {canEdit && a.sourceStorageKey && a.status !== "PROCESSING" && (
                      <button
                        onClick={() => void transcode(a)}
                        className="rounded bg-slate-800 px-2 py-1 text-xs font-medium text-emerald-400 hover:bg-slate-700"
                      >
                        Transcode
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
