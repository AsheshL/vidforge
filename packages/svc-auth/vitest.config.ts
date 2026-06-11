import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: { CONTEXT_SIGNING_SECRET: "test-signing-secret" },
  },
});
