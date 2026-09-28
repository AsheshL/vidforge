"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { GATEWAY_URL, storeSession } from "@/lib/api";

const inputClass =
  "rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-500 focus:border-sky-500 focus:outline-none disabled:opacity-60";

// gRPC ALREADY_EXISTS, mapped to HTTP 409 by /v1/portal/auth/activate —
// this specific case gets a distinct message rather than the raw server
// error, per the plan's Review Focus #3 (re-opening a stale/used link).
const ALREADY_ACTIVATED_STATUS = 409;

export default function ActivatePage() {
  const { orgSlug, token } = useParams<{ orgSlug: string; token: string }>();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [alreadyActivated, setAlreadyActivated] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${GATEWAY_URL}/v1/portal/auth/activate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orgSlug, token, password }),
      });
      if (res.status === ALREADY_ACTIVATED_STATUS) {
        setAlreadyActivated(true);
        setBusy(false);
        return;
      }
      const data = await res.json();
      if (!res.ok) {
        throw new Error(typeof data?.error === "string" ? data.error : "this invite link is invalid or expired");
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

  if (alreadyActivated) {
    return (
      <main className="mx-auto flex max-w-sm flex-col gap-4 px-6 py-16 text-center">
        <p className="text-sm text-slate-300">
          This account has already been activated.
        </p>
        <a
          href={`/${orgSlug}/login`}
          className="rounded-md bg-sky-600 px-3 py-2 text-sm font-medium text-white hover:bg-sky-500"
        >
          Sign in instead
        </a>
      </main>
    );
  }

  return (
    <main className="mx-auto flex max-w-sm flex-col gap-4 px-6 py-16">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Set up your account</h2>
        <p className="mt-1 text-sm text-slate-400">Choose a password to finish activating your account.</p>
      </div>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <input
          required
          type="password"
          placeholder="Password (8+ characters)"
          minLength={8}
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
          {busy ? "Activating…" : "Activate account"}
        </button>
      </form>
    </main>
  );
}
