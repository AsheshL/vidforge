"use client";

import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import { GATEWAY_URL, getToken } from "@/lib/api";

export function Player({ jobId }: { jobId: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [levels, setLevels] = useState<string[]>([]);
  // -1 = auto (hls.js ABR picks the rendition)
  const [level, setLevel] = useState(-1);
  const hlsRef = useRef<Hls | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    const token = getToken();
    if (!video) return;
    if (!token) {
      setError("Sign in with a test account to play this video.");
      return;
    }
    if (!Hls.isSupported()) {
      setError("hls.js is not supported in this browser.");
      return;
    }

    const hls = new Hls({
      // Playlists come from the gateway and need the bearer token; segments
      // are presigned S3 URLs that must be fetched without extra headers.
      xhrSetup: (xhr, url) => {
        if (url.startsWith(GATEWAY_URL)) {
          xhr.setRequestHeader("authorization", `Bearer ${token}`);
        }
      },
    });
    hlsRef.current = hls;
    hls.loadSource(`${GATEWAY_URL}/v1/jobs/${jobId}/hls/master.m3u8`);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
      setLevels(data.levels.map((l) => `${l.height}p`));
    });
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (data.fatal) {
        setError(
          data.response?.code === 401 || data.response?.code === 403
            ? "Not authorized to play this video."
            : `Playback error: ${data.details}`,
        );
        hls.destroy();
      }
    });

    return () => hls.destroy();
  }, [jobId]);

  function selectLevel(value: number) {
    setLevel(value);
    if (hlsRef.current) hlsRef.current.currentLevel = value;
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
        muted
        playsInline
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
    </div>
  );
}
