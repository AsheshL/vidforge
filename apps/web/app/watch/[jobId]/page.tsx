import Link from "next/link";
import { Player } from "@/components/Player";

export default async function WatchPage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}) {
  const { jobId } = await params;

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-6 px-6 py-12">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">VidForge</h1>
          <p className="text-sm text-slate-400">
            Playing job <span className="font-mono text-slate-300">{jobId.slice(-8)}</span>
          </p>
        </div>
        <Link
          href="/"
          className="rounded-md border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800"
        >
          ← Back to jobs
        </Link>
      </header>

      <Player jobId={jobId} />
    </main>
  );
}
