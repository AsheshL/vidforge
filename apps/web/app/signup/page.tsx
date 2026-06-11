import Link from "next/link";
import { AuthForm } from "@/components/AuthForm";

export default function SignupPage() {
  return (
    <main className="mx-auto flex max-w-md flex-col gap-8 px-6 py-16">
      <header className="text-center">
        <Link href="/" className="text-2xl font-semibold tracking-tight">
          VidForge
        </Link>
        <p className="mt-1 text-sm text-slate-400">Create an account or sign in</p>
      </header>
      <AuthForm />
    </main>
  );
}
