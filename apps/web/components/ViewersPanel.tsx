"use client";

import { useCallback, useEffect, useState } from "react";
import { GATEWAY_URL, authHeaders, type Viewer } from "@/lib/api";

const inputClass =
  "rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-500 focus:border-sky-500 focus:outline-none";

function statusOf(v: Viewer): { label: string; className: string } {
  if (v.revokedAt) return { label: "Revoked", className: "text-rose-400" };
  if (v.activatedAt) return { label: "Active", className: "text-emerald-400" };
  return { label: "Invited", className: "text-amber-400" };
}

export function ViewersPanel() {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [viewers, setViewers] = useState<Viewer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");

  const refresh = useCallback(async () => {
    const res = await fetch(`${GATEWAY_URL}/v1/viewers`, { headers: authHeaders(), cache: "no-store" });
    setAllowed(res.ok);
    if (res.ok) setViewers((await res.json()).viewers ?? []);
  }, []);

  useEffect(() => void refresh(), [refresh]);

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${GATEWAY_URL}/v1/viewers/invite`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders() },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(typeof data?.error === "string" ? data.error : `invite failed: ${res.status}`);
      }
      setEmail("");
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(viewerId: string) {
    setError(null);
    const res = await fetch(`${GATEWAY_URL}/v1/viewers/${viewerId}/revoke`, {
      method: "POST",
      headers: authHeaders(),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(typeof body?.error === "string" ? body.error : `revoke failed: ${res.status}`);
    }
    await refresh();
  }

  if (allowed === null) return null;
  if (!allowed) {
    return <p className="text-sm text-slate-400">Only org admins can manage viewers.</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-lg border border-slate-800 p-4">
        <h2 className="mb-3 text-lg font-medium">Invite a viewer</h2>
        <form onSubmit={invite} className="flex flex-wrap items-center gap-2">
          <input
            required
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={`${inputClass} w-64`}
          />
          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
          >
            {busy ? "Inviting…" : "Send invite"}
          </button>
        </form>
        {error && <p className="mt-2 text-xs text-rose-400">{error}</p>}
      </section>

      <section className="overflow-hidden rounded-lg border border-slate-800">
        <h2 className="bg-slate-900 px-4 py-2.5 text-sm font-medium text-slate-300">
          Viewers ({viewers.length})
        </h2>
        <table className="w-full text-sm">
          <tbody className="divide-y divide-slate-800">
            {viewers.length === 0 && (
              <tr>
                <td colSpan={3} className="px-4 py-6 text-center text-slate-500">
                  No viewers invited yet.
                </td>
              </tr>
            )}
            {viewers.map((v) => {
              const status = statusOf(v);
              return (
                <tr key={v.viewerId} className="bg-slate-950">
                  <td className="px-4 py-3 text-slate-200">{v.email}</td>
                  <td className={`px-4 py-3 text-xs font-medium ${status.className}`}>{status.label}</td>
                  <td className="px-4 py-3 text-right">
                    {!v.revokedAt && (
                      <button
                        onClick={() => void revoke(v.viewerId)}
                        className="rounded-md border border-rose-800 px-2 py-1 text-xs text-rose-400 hover:bg-rose-950"
                      >
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}
