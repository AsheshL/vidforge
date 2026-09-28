"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { GATEWAY_URL, authHeaders, type OrgIdentity } from "@/lib/api";

const inputClass =
  "rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-500 focus:border-sky-500 focus:outline-none";

function readFileAsDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("failed to read file"));
    reader.readAsDataURL(file);
  });
}

export function OrgBrandingPanel() {
  const [org, setOrg] = useState<OrgIdentity | null>(null);
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    const res = await fetch(`${GATEWAY_URL}/v1/org`, { headers: authHeaders(), cache: "no-store" });
    setAllowed(res.ok);
    if (res.ok) {
      const data = (await res.json()) as OrgIdentity;
      setOrg(data);
      setDisplayName(data.displayName ?? "");
    }
  }, []);

  useEffect(() => void refresh(), [refresh]);

  async function save(patch: { displayName?: string; logoDataUri?: string }) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`${GATEWAY_URL}/v1/org`, {
        method: "PATCH",
        headers: { "content-type": "application/json", ...authHeaders() },
        body: JSON.stringify(patch),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(typeof data?.error === "string" ? data.error : `update failed: ${res.status}`);
      }
      setMessage({ ok: true, text: "Saved." });
      await refresh();
    } catch (err) {
      setMessage({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  if (allowed === null) return null;
  if (!allowed) {
    return <p className="text-sm text-slate-400">Only org admins can edit branding.</p>;
  }

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-slate-800 p-4">
      <div className="flex items-center gap-4">
        {org?.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={org.logoUrl} alt="" className="h-12 w-12 rounded object-contain" />
        ) : (
          <div className="h-12 w-12 rounded bg-slate-800" />
        )}
        <div className="flex flex-col gap-1">
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/svg+xml"
            className="hidden"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              const logoDataUri = await readFileAsDataUri(file);
              await save({ logoDataUri });
            }}
          />
          <button
            onClick={() => fileInput.current?.click()}
            disabled={busy}
            className="rounded-md border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-50"
          >
            Upload logo
          </button>
          <p className="text-[11px] text-slate-500">PNG, JPEG or SVG, under 2MB.</p>
        </div>
      </div>

      <label className="flex flex-col gap-1 text-xs text-slate-400">
        Portal display name
        <div className="flex gap-2">
          <input
            placeholder={org?.name ?? ""}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className={`${inputClass} flex-1`}
          />
          <button
            onClick={() => void save({ displayName })}
            disabled={busy}
            className="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
          >
            Save
          </button>
        </div>
        <span>Shown to viewers in the portal header in place of "{org?.name}".</span>
      </label>

      {org?.slug && <p className="text-xs text-slate-500">Portal slug: <span className="font-mono">{org.slug}</span></p>}
      {message && (
        <p className={`text-xs ${message.ok ? "text-emerald-400" : "text-rose-400"}`}>{message.text}</p>
      )}
    </div>
  );
}
