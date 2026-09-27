import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // service.ts calls into @vidforge/svc-auth's verifyContext/signContext,
    // which throw if this isn't set — same as packages/svc-auth's own config.
    env: { CONTEXT_SIGNING_SECRET: "test-signing-secret" },
    // The @vidforge/db mock's vi.fn()s are module-level singletons shared
    // across every test in the file; without this, call history from one
    // test (e.g. "created" assertions) leaks into the next.
    clearMocks: true,
  },
});
