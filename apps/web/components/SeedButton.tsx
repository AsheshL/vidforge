"use client";

import { useState } from "react";
import { GATEWAY_URL, authHeaders } from "@/lib/api";

export function SeedButton({ onSeeded }: { onSeeded: () => Promise<void> | void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function seed() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${GATEWAY_URL}/v1/dev/seed`, {
        method: "POST",
        headers: authHeaders(),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `seed failed: ${res.status}`);
      }
      await onSeeded();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      {error && <span className="text-xs text-rose-400">{error}</span>}
      <button
        onClick={() => void seed()}
        disabled={busy}
        className="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
      >
        {busy ? "Seeding…" : "Seed test video"}
      </button>
    </div>
  );
}
