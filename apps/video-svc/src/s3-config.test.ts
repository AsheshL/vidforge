import { afterEach, describe, expect, it } from "vitest";
import { resolveS3Config } from "./s3-config.js";

const ENV_KEYS = ["S3_ACCESS_KEY", "S3_SECRET_KEY", "S3_ENDPOINT", "S3_REGION"] as const;
const saved: Record<string, string | undefined> = {};

function clearEnv() {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("resolveS3Config", () => {
  it("uses explicit MinIO-shaped credentials and path-style when S3_ACCESS_KEY is set", () => {
    clearEnv();
    process.env.S3_ACCESS_KEY = "vidforge";
    process.env.S3_SECRET_KEY = "vidforge-secret";

    const config = resolveS3Config("http://localhost:9000");

    expect(config.credentials).toEqual({ accessKeyId: "vidforge", secretAccessKey: "vidforge-secret" });
    expect(config.forcePathStyle).toBe(true);
  });

  it("falls through to the SDK default credential chain when unset (prod/ECS shape)", () => {
    clearEnv();

    const config = resolveS3Config(process.env.S3_ENDPOINT);

    expect(config.credentials).toBeUndefined();
    expect(config.forcePathStyle).toBe(false);
    expect(config.endpoint).toBeUndefined();
  });
});
