"use client";

import { useCallback, useEffect, useState } from "react";
import { GATEWAY_URL, ROLE_NAMES, authHeaders } from "@/lib/api";

interface ApiKey {
  keyId: string;
  name: string;
  role: number;
  createdBy: string;
  expiresAt?: string;
  revokedAt?: string;
  createdAt: string;
}

const ASSIGNABLE = ["VIEWER", "EDITOR", "ADMIN", "OWNER"] as const;

const inputClass =
  "rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-500 focus:border-sky-500 focus:outline-none";

function keyStatus(k: ApiKey): { label: string; color: string } {
  if (k.revokedAt) return { label: "Revoked", color: "text-slate-500" };
  if (k.expiresAt && new Date(k.expiresAt) < new Date()) return { label: "Expired", color: "text-amber-400" };
  return { label: "Active", color: "text-emerald-400" };
}

export function ApiKeysPanel() {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ name: "", role: "VIEWER" as (typeof ASSIGNABLE)[number], expiresAt: "" });
  // Only ever populated right after creation — never re-fetched, never persisted.
  const [mintedSecret, setMintedSecret] = useState<{ keyId: string; secret: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    const res = await fetch(`${GATEWAY_URL}/v1/org/api-keys`, { headers: authHeaders(), cache: "no-store" });
    setAllowed(res.ok);
    if (res.ok) setKeys((await res.json()).apiKeys ?? []);
  }, []);

  useEffect(() => void refresh(), [refresh]);

  async function createKey(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${GATEWAY_URL}/v1/org/api-keys`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          name: form.name,
          role: form.role,
          ...(form.expiresAt ? { expiresAt: new Date(form.expiresAt).toISOString() } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(typeof data?.error === "string" ? data.error : `create failed: ${res.status}`);
      }
      setMintedSecret({ keyId: data.keyId, secret: data.secret });
      setCopied(false);
      setForm({ name: "", role: "VIEWER", expiresAt: "" });
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function revokeKey(keyId: string) {
    setError(null);
    const res = await fetch(`${GATEWAY_URL}/v1/org/api-keys/${keyId}/revoke`, {
      method: "POST",
      headers: authHeaders(),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(typeof body?.error === "string" ? body.error : `revoke failed: ${res.status}`);
    }
    await refresh();
  }

  async function copySecret() {
    try {
      await navigator.clipboard.writeText(mintedSecret!.secret);
      setCopied(true);
    } catch {
      // Clipboard access can be denied — the secret is still selectable text.
    }
  }

  if (allowed === null) return null;
  if (!allowed) {
    return <p className="text-sm text-slate-400">Only org admins can manage API keys.</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      {mintedSecret && (
        <section className="rounded-lg border border-amber-600/50 bg-amber-950/30 p-4">
          <h2 className="mb-1 text-sm font-medium text-amber-300">API key created</h2>
          <p className="mb-3 text-xs text-amber-200/80">
            This secret is shown once and cannot be retrieved again. Copy it now and store it somewhere safe.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 overflow-x-auto rounded-md border border-amber-700/50 bg-slate-950 px-3 py-2 text-xs text-amber-100">
              {mintedSecret.secret}
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
            onClick={() => setMintedSecret(null)}
            className="mt-3 text-xs text-slate-400 underline hover:text-slate-300"
          >
            I've saved it — dismiss
          </button>
        </section>
      )}

      <section className="rounded-lg border border-slate-800 p-4">
        <h2 className="mb-3 text-lg font-medium">Create API key</h2>
        <form onSubmit={createKey} className="flex flex-col gap-3 sm:flex-row sm:items-end sm:flex-wrap">
          <label className="flex flex-1 flex-col gap-1 text-xs text-slate-400">
            Name
            <input
              required
              placeholder="e.g. CI pipeline"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-slate-400">
            Role
            <select
              value={form.role}
              onChange={(e) => setForm((f) => ({ ...f, role: e.target.value as (typeof ASSIGNABLE)[number] }))}
              className={inputClass}
            >
              {ASSIGNABLE.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-slate-400">
            Expires (optional)
            <input
              type="date"
              value={form.expiresAt}
              onChange={(e) => setForm((f) => ({ ...f, expiresAt: e.target.value }))}
              className={inputClass}
            />
          </label>
          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-sky-600 px-3 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
          >
            {busy ? "Creating…" : "Create key"}
          </button>
        </form>
        {error && <p className="mt-2 text-xs text-rose-400">{error}</p>}
      </section>

      <section className="overflow-hidden rounded-lg border border-slate-800">
        <h2 className="bg-slate-900 px-4 py-2.5 text-sm font-medium text-slate-300">
          API keys ({keys.length})
        </h2>
        <table className="w-full text-sm">
          <tbody className="divide-y divide-slate-800">
            {keys.length === 0 && (
              <tr>
                <td className="px-4 py-6 text-center text-slate-500">No API keys yet.</td>
              </tr>
            )}
            {keys.map((k) => {
              const st = keyStatus(k);
              return (
                <tr key={k.keyId} className="bg-slate-950">
                  <td className="px-4 py-3 text-slate-200">{k.name}</td>
                  <td className="px-4 py-3 text-xs text-slate-400">{ROLE_NAMES[k.role] ?? k.role}</td>
                  <td className={`px-4 py-3 text-xs ${st.color}`}>{st.label}</td>
                  <td className="px-4 py-3 text-xs text-slate-500">
                    {k.expiresAt ? `expires ${new Date(k.expiresAt).toLocaleDateString()}` : "no expiry"}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {!k.revokedAt && (
                      <button
                        type="button"
                        onClick={() => void revokeKey(k.keyId)}
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
