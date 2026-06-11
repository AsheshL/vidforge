"use client";

import { useEffect, useRef, useState } from "react";
import { clearSession, getStoredUser, type SessionUser } from "@/lib/api";

export function UserMenu() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setUser(getStoredUser());
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  // Avoid a hydration flash: render nothing until localStorage is read.
  if (!mounted) return null;

  if (!user) {
    return (
      <a
        href="/signup"
        className="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500"
      >
        Sign in
      </a>
    );
  }

  const isAdmin = user.role === "ADMIN" || user.role === "OWNER";

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded-md border border-slate-700 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800"
      >
        {user.displayName}
        <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] uppercase text-slate-400">
          {user.role}
        </span>
        <svg width="10" height="6" viewBox="0 0 10 6" className="text-slate-500">
          <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 z-10 mt-1.5 w-44 overflow-hidden rounded-md border border-slate-700 bg-slate-900 py-1 text-sm shadow-xl">
          <a href="/settings" className="block px-3 py-1.5 text-slate-200 hover:bg-slate-800">
            Settings
          </a>
          {isAdmin && (
            <>
              <a href="/org" className="block px-3 py-1.5 text-slate-200 hover:bg-slate-800">
                Organization
              </a>
              <a href="/invite" className="block px-3 py-1.5 text-slate-200 hover:bg-slate-800">
                Invite members
              </a>
            </>
          )}
          <div className="my-1 border-t border-slate-800" />
          <button
            onClick={() => {
              clearSession();
              window.location.href = "/";
            }}
            className="block w-full px-3 py-1.5 text-left text-rose-400 hover:bg-slate-800"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
