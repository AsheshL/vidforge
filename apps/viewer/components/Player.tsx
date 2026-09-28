"use client";

import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import { GATEWAY_URL, getToken, portalFetch, type ThumbnailsResponse } from "@/lib/api";
import { shouldReportProgress } from "@/lib/progress";

const PROGRESS_THRESHOLD_SECONDS = 10;

export function Player({
  orgSlug,
  assetId,
  jobId,
  startPositionSeconds,
}: {
  orgSlug: string;
  assetId: string;
  jobId: string;
  startPositionSeconds: number;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [levels, setLevels] = useState<string[]>([]);
  const [level, setLevel] = useState(-1);
  const hlsRef = useRef<Hls | null>(null);
  const [thumbnails, setThumbnails] = useState<string[]>([]);
  const lastReportRef = useRef<{ atMs: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await portalFetch(orgSlug, `/v1/portal/jobs/${jobId}/thumbnails`);
      if (!res.ok || cancelled) return;
      const body = (await res.json()) as ThumbnailsResponse;
      if (!cancelled) setThumbnails(body.thumbnails ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, [orgSlug, jobId]);

  useEffect(() => {
    const video = videoRef.current;
    const token = getToken(orgSlug);
    if (!video) return;
    if (!token) {
      setError("Sign in to play this video.");
      return;
    }
    if (!Hls.isSupported()) {
      setError("hls.js is not supported in this browser.");
      return;
    }

    const hls = new Hls({
      xhrSetup: (xhr, url) => {
        if (url.startsWith(GATEWAY_URL)) {
          xhr.setRequestHeader("authorization", `Bearer ${token}`);
        }
      },
    });
    hlsRef.current = hls;
    hls.loadSource(`${GATEWAY_URL}/v1/portal/jobs/${jobId}/hls/master.m3u8`);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
      setLevels(data.levels.map((l) => `${l.height}p`));
      if (startPositionSeconds > 0) video.currentTime = startPositionSeconds;
    });
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (data.fatal) {
        setError(
          data.response?.code === 401 || data.response?.code === 403
            ? "Not authorized to play this video."
            : data.response?.code === 404
              ? "This video is no longer available."
              : `Playback error: ${data.details}`,
        );
        hls.destroy();
      }
    });

    return () => hls.destroy();
  }, [orgSlug, jobId, startPositionSeconds]);

  function reportProgress(positionSeconds: number, forced = false) {
    const now = Date.now();
    if (!shouldReportProgress(lastReportRef.current, { atMs: now, forced }, PROGRESS_THRESHOLD_SECONDS)) return;
    lastReportRef.current = { atMs: now };
    void portalFetch(orgSlug, `/v1/portal/progress/${assetId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ positionSeconds }),
    });
  }

  function selectLevel(value: number) {
    setLevel(value);
    if (hlsRef.current) hlsRef.current.currentLevel = value;
  }

  function seekToThumbnail(i: number) {
    const video = videoRef.current;
    if (!video || !video.duration || thumbnails.length === 0) return;
    video.currentTime = (i / thumbnails.length) * video.duration;
  }

  if (error) {
    return (
      <div className="flex h-64 items-center justify-center rounded-lg border border-slate-800 bg-slate-900">
        <p className="text-sm text-rose-400">{error}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <video
        ref={videoRef}
        controls
        autoPlay
        playsInline
        onTimeUpdate={(e) => reportProgress(e.currentTarget.currentTime)}
        onPause={(e) => reportProgress(e.currentTarget.currentTime, true)}
        className="aspect-video w-full rounded-lg border border-slate-800 bg-black"
      />
      {levels.length > 0 && (
        <div className="flex items-center gap-2 text-xs text-slate-400">
          <span>Quality:</span>
          <button
            onClick={() => selectLevel(-1)}
            className={`rounded px-2 py-0.5 ${level === -1 ? "bg-sky-600 text-white" : "bg-slate-800 hover:bg-slate-700"}`}
          >
            Auto
          </button>
          {levels.map((label, i) => (
            <button
              key={label}
              onClick={() => selectLevel(i)}
              className={`rounded px-2 py-0.5 ${level === i ? "bg-sky-600 text-white" : "bg-slate-800 hover:bg-slate-700"}`}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {thumbnails.length > 0 && (
        <div className="flex items-center gap-2 overflow-x-auto pb-1">
          {thumbnails.map((src, i) => (
            <button
              key={src}
              onClick={() => seekToThumbnail(i)}
              className="shrink-0 overflow-hidden rounded border border-slate-800 hover:border-sky-500"
              title={`Seek to ${i + 1} of ${thumbnails.length}`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={src} alt="" className="aspect-video w-24 object-cover" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
