import type { S3ClientConfig } from "@aws-sdk/client-s3";

// MinIO-shaped config when S3_ACCESS_KEY/S3_SECRET_KEY are set (dev,
// docker-compose): explicit credentials, forced path-style, whatever
// endpoint is configured. Unset in prod (ECS): credentials/endpoint come
// back undefined, so the SDK falls through to its default provider chain
// (the ECS task's IAM role) and resolves the real regional S3 endpoint —
// forcePathStyle must be off for that to work against real S3.
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
