import { AssetsBoard } from "@/components/AssetsBoard";
import { JobsBoard } from "@/components/JobsBoard";
import { UserMenu } from "@/components/UserMenu";

export default function Home() {
  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-8 px-6 py-12">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">VidForge</h1>
          <p className="text-sm text-slate-400">Video transcoding dashboard</p>
        </div>
        <UserMenu />
      </header>

      <AssetsBoard />
      <JobsBoard />
    </main>
  );
}
