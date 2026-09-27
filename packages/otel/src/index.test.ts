import { trace } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { afterEach, describe, expect, it } from "vitest";
import { startTracing, tagTraceId, TRACE_ID_ATTRIBUTE, type TracingHandle } from "./index.js";

const started: TracingHandle[] = [];

afterEach(async () => {
  for (const handle of started.splice(0)) await handle.shutdown();
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  // The OTel API only ever honors the *first* global tracer provider
  // registration per process (later ones are silently ignored) — without
  // this, whichever test runs first "wins" the global for every test after
  // it, regardless of which provider that test itself constructed.
  trace.disable();
});

describe("startTracing", () => {
  it("does not throw or hang when no collector is reachable at the default endpoint", () => {
    // No OTEL_EXPORTER_OTLP_ENDPOINT set: falls back to the sidecar's usual
    // localhost address, which has nothing listening on it in this test.
    const handle = startTracing("test-service");
    expect(handle).not.toBeNull();
    if (handle) started.push(handle);
  });

  it("does not throw when pointed at an endpoint nothing is listening on", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:1";
    const handle = startTracing("test-service");
    expect(handle).not.toBeNull();
    if (handle) started.push(handle);
  });

  it("does not throw when the endpoint is an unresolvable host", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://this-host-does-not-exist.invalid:4318";
    const handle = startTracing("test-service");
    expect(handle).not.toBeNull();
    if (handle) started.push(handle);
  });

  it("shutdown resolves even with nothing to flush, and is safe to call twice", async () => {
    const handle = startTracing("test-service");
    expect(handle).not.toBeNull();
    await handle?.shutdown();
    await handle?.shutdown();
  });
});

describe("tagTraceId", () => {
  it("is a no-op with no active span", () => {
    expect(() => tagTraceId("some-trace-id")).not.toThrow();
  });

  it("is a no-op with no trace id", () => {
    expect(() => tagTraceId(undefined)).not.toThrow();
  });

  it("sets the correlation attribute on the active span", () => {
    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    provider.register();
    const tracer = trace.getTracer("test");

    tracer.startActiveSpan("unit-test-span", (span) => {
      tagTraceId("req-123");
      span.end();
    });

    const [span] = exporter.getFinishedSpans();
    expect(span.attributes[TRACE_ID_ATTRIBUTE]).toBe("req-123");

    void provider.shutdown();
  });
});
