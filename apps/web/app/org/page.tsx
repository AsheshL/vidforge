import Link from "next/link";
import { OrgPanel } from "@/components/OrgPanel";
import { ApiKeysPanel } from "@/components/ApiKeysPanel";
import { WebhooksPanel } from "@/components/WebhooksPanel";
import { ViewersPanel } from "@/components/ViewersPanel";

export default function OrgPage() {
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-12">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Organization</h1>
        <div className="flex gap-2">
          <Link
            href="/invite"
            className="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500"
          >
            Invite members
          </Link>
          <Link
            href="/"
            className="rounded-md border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800"
          >
            ← Back
          </Link>
        </div>
      </header>
      <OrgPanel />
      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold tracking-tight">API keys</h2>
        <ApiKeysPanel />
      </section>
      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold tracking-tight">Webhooks</h2>
        <WebhooksPanel />
      </section>
      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold tracking-tight">Viewer portal</h2>
        <ViewersPanel />
      </section>
    </main>
  );
}
