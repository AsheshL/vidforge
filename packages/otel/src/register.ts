import { register } from "node:module";
import { startTracing } from "./index.js";

/**
 * Installs OpenTelemetry's ESM loader hook, then starts tracing for the
 * current service (name from `OTEL_SERVICE_NAME`).
 *
 * This file must be loaded via `node --import` (or the tsx equivalent,
 * `tsx --import`) — see each service's Dockerfile `CMD` and `package.json`
 * `dev` script — rather than imported normally from the top of `main.ts`.
 *
 * Why: for a plain ECMAScript module graph, Node resolves and loads every
 * statically-imported module *before* any of their top-level code runs. So
 * even a `startTracing()` call written as the very first line of `main.ts`
 * runs too late to patch `@grpc/grpc-js` — by the time it executes,
 * `@grpc/grpc-js` (imported a few lines below it in the same file) may
 * already be loaded, and `@opentelemetry/instrumentation-grpc`'s hook can
 * no longer intercept it. This was verified empirically while building this
 * module: a plain top-of-file import produced no active span at all during
 * request handling, silently disabling the trace_id correlation this whole
 * feature depends on.
 *
 * `--import` sidesteps this: it loads and evaluates this file as its own,
 * separate step before Node even begins resolving the entrypoint's module
 * graph, so the loader hook (`register` below) and the SDK
 * (`startTracing`) are both fully installed first.
 *
 * (The `import` of `./index.js` above is hoisted and evaluated before this
 * line regardless of source order, but that's harmless here — unlike
 * `main.ts`, nothing this file imports needs to instrument `@grpc/grpc-js`,
 * so there's no ordering hazard between the two.)
 */
register("@opentelemetry/instrumentation/hook.mjs", import.meta.url);

startTracing(process.env.OTEL_SERVICE_NAME ?? "unknown-vidforge-service");
