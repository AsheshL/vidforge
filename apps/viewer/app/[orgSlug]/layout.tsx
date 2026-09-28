"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { GATEWAY_URL, type OrgBranding } from "@/lib/api";

export default function OrgLayout({ children }: { children: React.ReactNode }) {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const [branding, setBranding] = useState<OrgBranding | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetch(`${GATEWAY_URL}/v1/portal/org/${orgSlug}`, { cache: "no-store" });
      if (cancelled) return;
      if (!res.ok) {
        setNotFound(true);
        return;
      }
      setBranding(await res.json());
    })();
    return () => {
      cancelled = true;
    };
  }, [orgSlug]);

  if (notFound) {
    return (
      <main className="flex min-h-screen items-center justify-center px-6 text-center">
        <p className="text-sm text-slate-400">No such video library.</p>
      </main>
    );
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center gap-3 border-b border-slate-800 px-6 py-4">
        {branding?.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={branding.logoUrl} alt="" className="h-8 w-8 rounded object-contain" />
        ) : (
          <div className="h-8 w-8 rounded bg-slate-800" />
        )}
        <h1 className="text-lg font-semibold tracking-tight">{branding?.displayName ?? ""}</h1>
      </header>
      <div className="flex-1">{children}</div>
    </div>
  );
}
