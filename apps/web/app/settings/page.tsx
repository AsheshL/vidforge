import Link from "next/link";
import { SettingsPanel } from "@/components/SettingsPanel";

export default function SettingsPage() {
  return (
    <main className="mx-auto flex max-w-md flex-col gap-6 px-6 py-12">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <Link
          href="/"
          className="rounded-md border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800"
        >
          ← Back
        </Link>
      </header>
      <SettingsPanel />
    </main>
  );
}
