// See apps/web/instrumentation.ts for the full rationale — this file's
// register() is Next.js's own OpenTelemetry integration point and runs
// before the server starts handling requests.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { registerOTel } = await import("@vercel/otel");
  registerOTel({ serviceName: "viewer" });
}
