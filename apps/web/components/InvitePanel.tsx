"use client";

import { useEffect, useState } from "react";
import { GATEWAY_URL, authHeaders, getStoredUser } from "@/lib/api";

const inputClass =
  "rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-200 placeholder:text-slate-500 focus:border-sky-500 focus:outline-none";

export function InvitePanel() {
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [form, setForm] = useState({ email: "", displayName: "", role: "VIEWER" });

  // Only admins/owners can invite; everyone else doesn't see the panel.
  useEffect(() => {
    const me = getStoredUser();
    setVisible(me?.role === "ADMIN" || me?.role === "OWNER");
  }, []);

  if (!visible) return null;

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`${GATEWAY_URL}/v1/org/invites`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders() },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(typeof data?.error === "string" ? data.error : `invite failed: ${res.status}`);
      }
      setMessage({ ok: true, text: `Invited ${data.email} — a temporary password was emailed to them.` });
      setForm({ email: "", displayName: "", role: "VIEWER" });
    } catch (err) {
      setMessage({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-slate-800 p-4">
      <div>
        <h2 className="text-lg font-medium">Invite a member</h2>
        <p className="text-xs text-slate-500">
          They'll receive a temporary password by email and set their own on first sign-in.
        </p>
      </div>
      <form onSubmit={invite} className="flex flex-wrap items-center gap-2">
        <input required placeholder="Name" value={form.displayName}
          onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value }))} className={inputClass} />
        <input required type="email" placeholder="Email" value={form.email}
          onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} className={`${inputClass} w-56`} />
        <select value={form.role}
          onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))} className={inputClass}>
          <option value="VIEWER">Viewer</option>
          <option value="EDITOR">Editor</option>
          <option value="ADMIN">Admin</option>
        </select>
        <button type="submit" disabled={busy}
          className="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50">
          {busy ? "Inviting…" : "Send invite"}
        </button>
      </form>
      {message && (
        <p className={`text-xs ${message.ok ? "text-emerald-400" : "text-rose-400"}`}>{message.text}</p>
      )}
    </section>
  );
}
