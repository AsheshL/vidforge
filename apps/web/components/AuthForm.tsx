"use client";

import { useState } from "react";
import { GATEWAY_URL, storeSession } from "@/lib/api";

type Mode = "signup" | "login" | "reset";

const inputClass =
  "rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-500 focus:border-sky-500 focus:outline-none disabled:opacity-60";

export function AuthForm() {
  const [mode, setMode] = useState<Mode>("signup");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    email: "",
    password: "",
    displayName: "",
    orgName: "",
    newPassword: "",
  });

  function set(field: keyof typeof form) {
    return (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((f) => ({ ...f, [field]: e.target.value }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const [path, body] =
        mode === "signup"
          ? ["signup", { email: form.email, password: form.password, displayName: form.displayName, orgName: form.orgName }]
          : mode === "login"
            ? ["login", { email: form.email, password: form.password }]
            : ["change-password", { email: form.email, currentPassword: form.password, newPassword: form.newPassword }];
      const res = await fetch(`${GATEWAY_URL}/v1/auth/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (res.status === 403 && data?.code === "PASSWORD_CHANGE_REQUIRED") {
        // Temp password accepted; collect a permanent one.
        setMode("reset");
        setBusy(false);
        return;
      }
      if (!res.ok) {
        throw new Error(typeof data?.error === "string" ? data.error : "check the form fields");
      }
      storeSession(data.token, data.user);
      window.location.href = "/";
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      {mode !== "reset" ? (
        <div className="mb-2 grid grid-cols-2 rounded-md border border-slate-700 p-0.5 text-sm">
          {(["signup", "login"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => { setMode(m); setError(null); }}
              className={`rounded px-3 py-1.5 ${mode === m ? "bg-slate-800 text-white" : "text-slate-400 hover:text-slate-200"}`}
            >
              {m === "signup" ? "Sign up" : "Sign in"}
            </button>
          ))}
        </div>
      ) : (
        <p className="mb-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          You signed in with a temporary password. Choose your own password to continue.
        </p>
      )}

      {mode === "signup" && (
        <>
          <input required placeholder="Display name" value={form.displayName} onChange={set("displayName")} className={inputClass} />
          <input placeholder="Organization name (optional)" value={form.orgName} onChange={set("orgName")} className={inputClass} />
        </>
      )}
      <input
        required
        type="email"
        placeholder="Email"
        value={form.email}
        onChange={set("email")}
        disabled={mode === "reset"}
        className={inputClass}
      />
      <input
        required
        type="password"
        placeholder={mode === "signup" ? "Password (8+ characters)" : mode === "reset" ? "Temporary password" : "Password"}
        minLength={mode === "signup" ? 8 : 1}
        value={form.password}
        onChange={set("password")}
        disabled={mode === "reset"}
        className={inputClass}
      />
      {mode === "reset" && (
        <input
          required
          type="password"
          placeholder="New password (8+ characters)"
          minLength={8}
          value={form.newPassword}
          onChange={set("newPassword")}
          autoFocus
          className={inputClass}
        />
      )}

      {error && <p className="text-xs text-rose-400">{error}</p>}

      <button
        type="submit"
        disabled={busy}
        className="mt-1 rounded-md bg-sky-600 px-3 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
      >
        {busy ? "Working…" : mode === "signup" ? "Create account" : mode === "reset" ? "Set new password" : "Sign in"}
      </button>
      {mode === "signup" && (
        <p className="text-center text-xs text-slate-500">
          You become the owner of a fresh organization — your jobs and assets are isolated from everyone else's.
        </p>
      )}
    </form>
  );
}
