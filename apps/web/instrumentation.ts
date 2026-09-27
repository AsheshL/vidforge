// Next.js's own OpenTelemetry integration point: this file's `register()` is
// called once, before the server starts handling requests, in whichever
// runtime the app is built for (Node here — see next.config.ts's
// `output: "standalone"`). This is the idiomatic way to start tracing in
// Next.js — unlike the other services in this monorepo (see
// packages/otel/src/register.ts), it doesn't need a `node --import` trick to
// run early enough, because Next.js itself guarantees this file runs before
// anything else.
//
// @vercel/otel wraps the OpenTelemetry Node SDK with sensible defaults for
// exactly this environment; by default it exports over OTLP/HTTP (matching
// the protocol every other VidForge service uses — see
// packages/otel/src/index.ts) to `OTEL_EXPORTER_OTLP_ENDPOINT`
// (`http://localhost:4318` here for local dev; the ECS task definition sets
// it to the ADOT collector sidecar in production). It resolves that
// endpoint lazily per-export, so — like the rest of this stack — there is
// nothing here that throws or blocks startup when no collector is
// reachable.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { registerOTel } = await import("@vercel/otel");
  registerOTel({ serviceName: "web" });
}
