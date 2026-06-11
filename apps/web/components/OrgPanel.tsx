"use client";

import { useCallback, useEffect, useState } from "react";
import { GATEWAY_URL, ROLE_NAMES, authHeaders, getStoredUser } from "@/lib/api";

interface Member {
  userId: string;
  email: string;
  displayName: string;
  role: number;
}

interface AuditEvent {
  eventId: string;
  actorUserId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  detailJson: string;
  occurredAt: string;
}

const ASSIGNABLE = ["VIEWER", "EDITOR", "ADMIN", "OWNER"] as const;

export function OrgPanel() {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const me = getStoredUser();

  const refresh = useCallback(async () => {
    const [m, a] = await Promise.all([
      fetch(`${GATEWAY_URL}/v1/org/members`, { headers: authHeaders(), cache: "no-store" }),
      fetch(`${GATEWAY_URL}/v1/org/audit`, { headers: authHeaders(), cache: "no-store" }),
    ]);
    setAllowed(m.ok);
    if (m.ok) setMembers((await m.json()).users ?? []);
    if (a.ok) setEvents((await a.json()).events ?? []);
  }, []);

  useEffect(() => void refresh(), [refresh]);

  async function changeRole(userId: string, role: string) {
    setError(null);
    const res = await fetch(`${GATEWAY_URL}/v1/org/members/${userId}/role`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({ role }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(typeof body?.error === "string" ? body.error : `role change failed: ${res.status}`);
    }
    await refresh();
  }

  if (allowed === null) return null;
  if (!allowed) {
    return <p className="text-sm text-slate-400">Only org admins can view this page.</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="overflow-hidden rounded-lg border border-slate-800">
        <h2 className="bg-slate-900 px-4 py-2.5 text-sm font-medium text-slate-300">
          Members ({members.length})
        </h2>
        <table className="w-full text-sm">
          <tbody className="divide-y divide-slate-800">
            {members.map((m) => (
              <tr key={m.userId} className="bg-slate-950">
                <td className="px-4 py-3 text-slate-200">
                  {m.displayName}
                  {m.userId === me?.userId && <span className="ml-1.5 text-xs text-slate-500">(you)</span>}
                </td>
                <td className="px-4 py-3 text-xs text-slate-400">{m.email}</td>
                <td className="px-4 py-3 text-right">
                  <select
                    value={ROLE_NAMES[m.role] ?? String(m.role)}
                    disabled={m.userId === me?.userId}
                    onChange={(e) => void changeRole(m.userId, e.target.value)}
                    className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200 disabled:opacity-50"
                  >
                    {ASSIGNABLE.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {error && <p className="px-4 py-2 text-xs text-rose-400">{error}</p>}
      </section>

      <section className="overflow-hidden rounded-lg border border-slate-800">
        <h2 className="bg-slate-900 px-4 py-2.5 text-sm font-medium text-slate-300">Audit log</h2>
        <table className="w-full text-sm">
          <tbody className="divide-y divide-slate-800">
            {events.length === 0 && (
              <tr>
                <td className="px-4 py-6 text-center text-slate-500">No events yet.</td>
              </tr>
            )}
            {events.map((e) => (
              <tr key={e.eventId} className="bg-slate-950">
                <td className="px-4 py-2.5 font-mono text-xs text-sky-400">{e.action}</td>
                <td className="px-4 py-2.5 text-xs text-slate-400">
                  {e.resourceType}/{e.resourceId.slice(-8)}
                  {e.detailJson && <span className="ml-1.5 text-slate-500">{e.detailJson}</span>}
                </td>
                <td className="px-4 py-2.5 text-xs text-slate-500">by {e.actorUserId.slice(-8)}</td>
                <td className="px-4 py-2.5 text-right text-xs text-slate-500">
                  {new Date(e.occurredAt).toLocaleString("en-GB", { hour12: false })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
