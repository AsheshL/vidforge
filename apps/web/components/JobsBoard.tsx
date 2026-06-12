"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  GATEWAY_URL,
  JOB_STATES,
  authHeaders,
  getStoredUser,
  getToken,
  sseUrl,
  type Job,
  type ProgressEvent,
} from "@/lib/api";
import { SeedButton } from "./SeedButton";

const ACTIVE = (state: number) => state === 1 || state === 2;

export function JobsBoard() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pageInfo, setPageInfo] = useState({ nextPageToken: "", totalCount: 0 });
  const [loadingMore, setLoadingMore] = useState(false);
  // Live progress per jobId, layered over the polled job list.
  const [live, setLive] = useState<Record<string, ProgressEvent>>({});
  const sources = useRef<Map<string, EventSource>>(new Map());

  const refresh = useCallback(async () => {
    if (!getToken()) {
      setAuthed(false);
      setJobs([]);
      return;
    }
    const res = await fetch(`${GATEWAY_URL}/v1/jobs?pageSize=20`, {
      cache: "no-store",
      headers: authHeaders(),
    });
    setAuthed(res.status !== 401 && res.status !== 403);
    if (res.ok) {
      const data = await res.json();
      setJobs(data.jobs ?? []);
      setPageInfo(data.pageInfo ?? { nextPageToken: "", totalCount: 0 });
    }
  }, []);

  async function loadMore() {
    if (!pageInfo.nextPageToken || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await fetch(
        `${GATEWAY_URL}/v1/jobs?pageSize=20&pageToken=${encodeURIComponent(pageInfo.nextPageToken)}`,
        { cache: "no-store", headers: authHeaders() },
      );
      if (res.ok) {
        const data = await res.json();
        setJobs((prev) => [...prev, ...(data.jobs ?? [])]);
        setPageInfo(data.pageInfo ?? { nextPageToken: "", totalCount: 0 });
      }
    } finally {
      setLoadingMore(false);
    }
  }

  useEffect(() => void refresh(), [refresh]);

  // AssetsBoard fires this after submitting a transcode.
  useEffect(() => {
    const onChanged = () => void refresh();
    window.addEventListener("vidforge:jobs-changed", onChanged);
    return () => window.removeEventListener("vidforge:jobs-changed", onChanged);
  }, [refresh]);

  async function jobAction(jobId: string, kind: "cancel" | "delete") {
    setActionError(null);
    const res = await fetch(
      kind === "cancel" ? `${GATEWAY_URL}/v1/jobs/${jobId}/cancel` : `${GATEWAY_URL}/v1/jobs/${jobId}`,
      { method: kind === "cancel" ? "POST" : "DELETE", headers: authHeaders() },
    );
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setActionError(typeof body?.error === "string" ? body.error : `${kind} failed: ${res.status}`);
    }
    await refresh();
  }

  // Mirrors the server-side rule (creator or admin) to avoid showing
  // buttons that would only 403; the server still enforces it.
  const me = getStoredUser();
  const canModify = (job: Job) =>
    !!me &&
    (job.createdByUserId === me.userId || me.role === "ADMIN" || me.role === "OWNER");

  // Subscribe to SSE for every active job; tear down when terminal.
  useEffect(() => {
    const map = sources.current;
    for (const job of jobs) {
      if (!ACTIVE(job.state) || map.has(job.jobId)) continue;
      const es = new EventSource(sseUrl(`/v1/jobs/${job.jobId}/events`));
      es.onmessage = (msg) => {
        const event: ProgressEvent = JSON.parse(msg.data);
        setLive((prev) => ({ ...prev, [event.jobId]: event }));
        if (!ACTIVE(event.state)) {
          es.close();
          map.delete(job.jobId);
          void refresh();
        }
      };
      es.onerror = () => {
        es.close();
        map.delete(job.jobId);
      };
      map.set(job.jobId, es);
    }
    return () => {
      // Cleanup only on unmount: close everything.
    };
  }, [jobs, refresh]);

  useEffect(() => {
    const map = sources.current;
    return () => {
      for (const es of map.values()) es.close();
      map.clear();
    };
  }, []);

  // Polling fallback while any job is active: SSE can miss the terminal
  // event if the job finishes during subscription setup.
  useEffect(() => {
    if (!jobs.some((j) => ACTIVE(j.state))) return;
    const id = setInterval(() => void refresh(), 2000);
    return () => clearInterval(id);
  }, [jobs, refresh]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium">
          Transcode jobs
          {pageInfo.totalCount > 0 && (
            <span className="ml-2 text-sm font-normal text-slate-500">
              {jobs.length} of {pageInfo.totalCount}
            </span>
          )}
        </h2>
        <div className="flex gap-2">
          <button
            onClick={() => void refresh()}
            className="rounded-md border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800"
          >
            Refresh
          </button>
          <SeedButton onSeeded={refresh} />
        </div>
      </div>

      {actionError && <p className="text-xs text-rose-400">{actionError}</p>}

      <div className="overflow-hidden rounded-lg border border-slate-800">
        <table className="w-full text-sm">
          <thead className="bg-slate-900 text-left text-slate-400">
            <tr>
              <th className="px-4 py-2.5 font-medium">Job</th>
              <th className="px-4 py-2.5 font-medium">Asset</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
              <th className="px-4 py-2.5 font-medium w-64">Progress</th>
              <th className="px-4 py-2.5 font-medium">Submitted</th>
              <th className="px-4 py-2.5 font-medium"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {jobs.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-slate-500">
                  {authed === false
                    ? "Sign in to see your jobs."
                    : "No jobs yet — seed a test video to get started."}
                </td>
              </tr>
            )}
            {jobs.map((job) => {
              const event = live[job.jobId];
              const state = event?.state ?? job.state;
              const percent = Math.round(event?.percent ?? job.progressPercent);
              const meta = JOB_STATES[state] ?? { label: `#${state}`, color: "text-slate-400" };
              return (
                <tr key={job.jobId} className="bg-slate-950">
                  <td className="px-4 py-3 font-mono text-xs text-slate-400">
                    {job.jobId.slice(-8)}
                  </td>
                  <td className="px-4 py-3 text-slate-300">{job.assetId.slice(-8)}</td>
                  <td className={`px-4 py-3 font-medium ${meta.color}`}>
                    {meta.label}
                    {event?.currentRendition && state === 2 && (
                      <span className="ml-1.5 text-xs text-slate-500">
                        {event.currentRendition}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-800">
                        <div
                          className={`h-full rounded-full transition-all duration-300 ${
                            state === 4 ? "bg-rose-500" : state === 3 ? "bg-emerald-500" : "bg-sky-500"
                          }`}
                          style={{ width: `${state === 3 ? 100 : percent}%` }}
                        />
                      </div>
                      <span className="w-10 text-right text-xs tabular-nums text-slate-400">
                        {state === 3 ? 100 : percent}%
                      </span>
                    </div>
                    {job.errorMessage && (
                      <p className="mt-1 text-xs text-rose-400">{job.errorMessage}</p>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-500">
                    {new Date(job.submittedAt).toLocaleTimeString("en-GB", { hour12: false })}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1.5">
                      {state === 3 && (
                        <a
                          href={`/watch/${job.jobId}`}
                          className="rounded bg-slate-800 px-2 py-1 text-xs font-medium text-sky-400 hover:bg-slate-700"
                        >
                          ▶ Play
                        </a>
                      )}
                      {(state === 1 || state === 2) && canModify(job) && (
                        <button
                          onClick={() => void jobAction(job.jobId, "cancel")}
                          className="rounded bg-slate-800 px-2 py-1 text-xs font-medium text-amber-400 hover:bg-slate-700"
                        >
                          Cancel
                        </button>
                      )}
                      {state >= 3 && canModify(job) && (
                        <button
                          onClick={() => void jobAction(job.jobId, "delete")}
                          className="rounded bg-slate-800 px-2 py-1 text-xs font-medium text-rose-400 hover:bg-slate-700"
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {pageInfo.nextPageToken && (
        <button
          onClick={() => void loadMore()}
          disabled={loadingMore}
          className="self-center rounded-md border border-slate-700 px-4 py-1.5 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-50"
        >
          {loadingMore ? "Loading…" : "Load more"}
        </button>
      )}
    </div>
  );
}
