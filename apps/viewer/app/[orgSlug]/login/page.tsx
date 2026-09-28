"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { GATEWAY_URL, storeSession } from "@/lib/api";

const inputClass =
  "rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-500 focus:border-sky-500 focus:outline-none disabled:opacity-60";

export default function LoginPage() {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${GATEWAY_URL}/v1/portal/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orgSlug, email, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(typeof data?.error === "string" ? data.error : "invalid email or password");
      }
      storeSession(orgSlug, data.token, {
        viewerId: data.viewer.viewerId,
        orgId: data.viewer.orgId,
        email: data.viewer.email,
      });
      window.location.href = `/${orgSlug}`;
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex max-w-sm flex-col gap-4 px-6 py-16">
      <h2 className="text-xl font-semibold tracking-tight">Sign in</h2>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <input
          required
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={busy}
          className={inputClass}
        />
        <input
          required
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy}
          className={inputClass}
        />
        {error && <p className="text-xs text-rose-400">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="rounded-md bg-sky-600 px-3 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
