import type { S3ClientConfig } from "@aws-sdk/client-s3";

// See apps/api-gateway/src/s3-config.ts for the full rationale — same
// resolver, duplicated because this is a different package.
export function resolveS3Config(endpoint = process.env.S3_ENDPOINT): S3ClientConfig {
  const accessKeyId = process.env.S3_ACCESS_KEY;
  const secretAccessKey = process.env.S3_SECRET_KEY;
  const explicitCreds = accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined;

  return {
    endpoint,
    region: process.env.S3_REGION ?? "us-east-1",
    forcePathStyle: Boolean(explicitCreds),
    credentials: explicitCreds,
  };
}
