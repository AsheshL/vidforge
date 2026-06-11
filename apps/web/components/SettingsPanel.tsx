"use client";

import { useEffect, useState } from "react";
import { GATEWAY_URL, getStoredUser, storeSession, type SessionUser } from "@/lib/api";

const inputClass =
  "rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-500 focus:border-sky-500 focus:outline-none";

export function SettingsPanel() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [mounted, setMounted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pw, setPw] = useState({ current: "", next: "" });

  useEffect(() => {
    setUser(getStoredUser());
    setMounted(true);
  }, []);

  if (!mounted) return null;
  if (!user) {
    return (
      <p className="text-sm text-slate-400">
        <a href="/signup" className="text-sky-400 hover:text-sky-300">Sign in</a> to manage your account.
      </p>
    );
  }

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`${GATEWAY_URL}/v1/auth/change-password`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: user!.email, currentPassword: pw.current, newPassword: pw.next }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(typeof data?.error === "string" ? data.error : "password change failed");
      }
      // Server returns a fresh session for the new credentials.
      storeSession(data.token, data.user);
      setPw({ current: "", next: "" });
      setMessage({ ok: true, text: "Password updated." });
    } catch (err) {
      setMessage({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-lg border border-slate-800 p-4">
        <h2 className="mb-3 text-lg font-medium">Profile</h2>
        <dl className="grid grid-cols-[100px_1fr] gap-y-1.5 text-sm">
          <dt className="text-slate-500">Name</dt>
          <dd className="text-slate-200">{user.displayName}</dd>
          <dt className="text-slate-500">Email</dt>
          <dd className="text-slate-200">{user.email}</dd>
          <dt className="text-slate-500">Role</dt>
          <dd>
            <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] uppercase text-slate-300">
              {user.role}
            </span>
          </dd>
        </dl>
      </section>

      <section className="rounded-lg border border-slate-800 p-4">
        <h2 className="mb-3 text-lg font-medium">Change password</h2>
        <form onSubmit={changePassword} className="flex flex-col gap-3">
          <input
            required
            type="password"
            placeholder="Current password"
            value={pw.current}
            onChange={(e) => setPw((p) => ({ ...p, current: e.target.value }))}
            className={inputClass}
          />
          <input
            required
            type="password"
            placeholder="New password (8+ characters)"
            minLength={8}
            value={pw.next}
            onChange={(e) => setPw((p) => ({ ...p, next: e.target.value }))}
            className={inputClass}
          />
          {message && (
            <p className={`text-xs ${message.ok ? "text-emerald-400" : "text-rose-400"}`}>{message.text}</p>
          )}
          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-sky-600 px-3 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
          >
            {busy ? "Updating…" : "Update password"}
          </button>
        </form>
      </section>
    </div>
  );
}
