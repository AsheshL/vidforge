"use client";

import { useEffect, useState } from "react";
import { GATEWAY_URL, authHeaders, getStoredUser } from "@/lib/api";
import { parseInvites } from "@/lib/parseInvites";

interface RowResult {
  email: string;
  ok: boolean;
  error?: string;
}

export function BulkInvitePanel() {
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");
  const [parseErrors, setParseErrors] = useState<string[]>([]);
  const [results, setResults] = useState<RowResult[] | null>(null);

  useEffect(() => {
    const me = getStoredUser();
    setVisible(me?.role === "ADMIN" || me?.role === "OWNER");
  }, []);

  if (!visible) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setResults(null);
    const { invites, errors } = parseInvites(text);
    setParseErrors(errors);
    if (errors.length || invites.length === 0) return;
    setBusy(true);
    try {
      const res = await fetch(`${GATEWAY_URL}/v1/org/invites/bulk`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders() },
        body: JSON.stringify({ invites }),
      });
      const data = await res.json();
      if (!res.ok && !Array.isArray(data?.results)) {
        throw new Error(typeof data?.error === "string" ? data.error : `bulk invite failed: ${res.status}`);
      }
      setResults(data.results);
      if (data.failed === 0) setText("");
    } catch (err) {
      setParseErrors([(err as Error).message]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-slate-800 p-4">
      <div>
        <h2 className="text-lg font-medium">Bulk invite</h2>
        <p className="text-xs text-slate-500">
          One person per line: <span className="font-mono text-slate-400">Name, email, role</span> — role is
          optional and defaults to Viewer. Up to 50 per batch.
        </p>
      </div>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={6}
          placeholder={"Ada Lovelace, ada@example.com, EDITOR\nGrace Hopper, grace@example.com"}
          className="rounded-md border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-xs text-slate-200 placeholder:text-slate-600 focus:border-sky-500 focus:outline-none"
        />
        {parseErrors.length > 0 && (
          <ul className="text-xs text-rose-400">
            {parseErrors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}
        <button
          type="submit"
          disabled={busy}
          className="self-start rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
        >
          {busy ? "Inviting…" : "Send invites"}
        </button>
      </form>

      {results && (
        <ul className="flex flex-col gap-1 text-xs">
          {results.map((r) => (
            <li key={r.email} className={r.ok ? "text-emerald-400" : "text-rose-400"}>
              {r.ok ? "✓" : "✕"} {r.email}
              {r.error ? ` — ${r.error}` : " — invited, temporary password emailed"}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
