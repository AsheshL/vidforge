import Link from "next/link";
import { InvitePanel } from "@/components/InvitePanel";
import { BulkInvitePanel } from "@/components/BulkInvitePanel";

export default function InvitePage() {
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-12">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Invite members</h1>
        <Link
          href="/"
          className="rounded-md border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800"
        >
          ← Back
        </Link>
      </header>
      <InvitePanel />
      <BulkInvitePanel />
    </main>
  );
}
