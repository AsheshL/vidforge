"use client";

import { useCallback, useEffect, useState } from "react";
import { GATEWAY_URL, authHeaders } from "@/lib/api";

interface Webhook {
  webhookId: string;
  url: string;
  events: string[];
  signingSecretHint: string;
  active: boolean;
}

// Public event names, as delivered in each payload's `type`.
const EVENTS = [
  { name: "job.enqueued", label: "Enqueued" },
  { name: "job.started", label: "Started" },
  { name: "job.completed", label: "Completed" },
  { name: "job.failed", label: "Failed" },
  { name: "job.retrying", label: "Retrying" },
] as const;

const inputClass =
  "rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-500 focus:border-sky-500 focus:outline-none";

export function WebhooksPanel() {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [hooks, setHooks] = useState<Webhook[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<string[]>(["job.completed", "job.failed"]);
  // Only ever populated right after creation — never re-fetched, never persisted.
  const [created, setCreated] = useState<{ url: string; secret: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    const res = await fetch(`${GATEWAY_URL}/v1/org/webhooks`, { headers: authHeaders(), cache: "no-store" });
    setAllowed(res.ok);
    if (res.ok) setHooks((await res.json()).webhooks ?? []);
  }, []);

  useEffect(() => void refresh(), [refresh]);

  function toggleEvent(name: string) {
    setEvents((cur) => (cur.includes(name) ? cur.filter((e) => e !== name) : [...cur, name]));
  }

  async function createHook(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${GATEWAY_URL}/v1/org/webhooks`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders() },
        body: JSON.stringify({ url, events }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(typeof data?.error === "string" ? data.error : `create failed: ${res.status}`);
      }
      setCreated({ url: data.url, secret: data.signingSecret });
      setCopied(false);
      setUrl("");
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function deleteHook(webhookId: string) {
    setError(null);
    const res = await fetch(`${GATEWAY_URL}/v1/org/webhooks/${webhookId}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(typeof body?.error === "string" ? body.error : `delete failed: ${res.status}`);
    }
    await refresh();
  }

  async function copySecret() {
    try {
      await navigator.clipboard.writeText(created!.secret);
      setCopied(true);
    } catch {
      // Clipboard access can be denied — the secret is still selectable text.
    }
  }

  if (allowed === null) return null;
  if (!allowed) {
    return <p className="text-sm text-slate-400">Only org admins can manage webhooks.</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      {created && (
        <section className="rounded-lg border border-amber-600/50 bg-amber-950/30 p-4">
          <h2 className="mb-1 text-sm font-medium text-amber-300">Webhook created</h2>
          <p className="mb-3 text-xs text-amber-200/80">
            Use this signing secret to verify the <code>vidforge-signature</code> header on each delivery. It is
            shown once and cannot be retrieved again.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 overflow-x-auto rounded-md border border-amber-700/50 bg-slate-950 px-3 py-2 text-xs text-amber-100">
              {created.secret}
            </code>
            <button
              type="button"
              onClick={() => void copySecret()}
              className="shrink-0 rounded-md border border-amber-600 px-3 py-2 text-xs font-medium text-amber-200 hover:bg-amber-900/40"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <button
            type="button"
            onClick={() => setCreated(null)}
            className="mt-3 text-xs text-slate-400 underline hover:text-slate-300"
          >
            I've saved it — dismiss
          </button>
        </section>
      )}

      <section className="rounded-lg border border-slate-800 p-4">
        <h2 className="mb-3 text-lg font-medium">Add webhook</h2>
        <form onSubmit={createHook} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs text-slate-400">
            Endpoint URL
            <input
              required
              type="url"
              placeholder="https://example.com/vidforge-webhook"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className={inputClass}
            />
          </label>
          <fieldset className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-slate-300">
            <legend className="mb-1 text-slate-400">Events</legend>
            {EVENTS.map((ev) => (
              <label key={ev.name} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={events.includes(ev.name)}
                  onChange={() => toggleEvent(ev.name)}
                  className="accent-sky-600"
                />
                {ev.label}
              </label>
            ))}
          </fieldset>
          <button
            type="submit"
            disabled={busy || events.length === 0}
            className="self-start rounded-md bg-sky-600 px-3 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
          >
            {busy ? "Adding…" : "Add webhook"}
          </button>
        </form>
        {error && <p className="mt-2 text-xs text-rose-400">{error}</p>}
      </section>

      <section className="overflow-hidden rounded-lg border border-slate-800">
        <h2 className="bg-slate-900 px-4 py-2.5 text-sm font-medium text-slate-300">Webhooks ({hooks.length})</h2>
        <table className="w-full text-sm">
          <tbody className="divide-y divide-slate-800">
            {hooks.length === 0 && (
              <tr>
                <td className="px-4 py-6 text-center text-slate-500">No webhooks yet.</td>
              </tr>
            )}
            {hooks.map((h) => (
              <tr key={h.webhookId} className="bg-slate-950">
                <td className="max-w-xs truncate px-4 py-3 text-slate-200" title={h.url}>
                  {h.url}
                </td>
                <td className="px-4 py-3 text-xs text-slate-400">{h.events.join(", ")}</td>
                <td className="whitespace-nowrap px-4 py-3 text-xs text-slate-500">secret …{h.signingSecretHint}</td>
                <td className={`px-4 py-3 text-xs ${h.active ? "text-emerald-400" : "text-slate-500"}`}>
                  {h.active ? "Active" : "Inactive"}
                </td>
                <td className="px-4 py-3 text-right">
                  <button
                    type="button"
                    onClick={() => void deleteHook(h.webhookId)}
                    className="rounded-md border border-rose-800 px-2 py-1 text-xs text-rose-400 hover:bg-rose-950"
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
