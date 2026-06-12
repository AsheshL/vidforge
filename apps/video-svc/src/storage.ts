import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type { Readable } from "node:stream";

export const BUCKET = process.env.S3_BUCKET ?? "vidforge-media";

export const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT ?? "http://localhost:9000",
  region: "us-east-1",
  forcePathStyle: true, // required for MinIO
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY ?? "vidforge",
    secretAccessKey: process.env.S3_SECRET_KEY ?? "vidforge-secret",
  },
});

export async function ensureBucket() {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
  }
}

export async function downloadToFile(key: string, destPath: string) {
  await mkdir(dirname(destPath), { recursive: true });
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  await pipeline(res.Body as Readable, createWriteStream(destPath));
}

export async function uploadFile(localPath: string, key: string, contentType?: string) {
  const upload = new Upload({
    client: s3,
    params: {
      Bucket: BUCKET,
      Key: key,
      Body: createReadStream(localPath),
      ContentType: contentType,
    },
  });
  await upload.done();
}

// Deletes every object under prefix. Returns the number of objects removed.
export async function deletePrefix(prefix: string): Promise<number> {
  let removed = 0;
  let continuationToken: string | undefined;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: continuationToken }),
    );
    const keys = (page.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
    if (keys.length > 0) {
      await s3.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: keys } }));
      removed += keys.length;
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
  return removed;
}

const CONTENT_TYPES: Record<string, string> = {
  ".m3u8": "application/vnd.apple.mpegurl",
  ".ts": "video/mp2t",
  ".mp4": "video/mp4",
  ".jpg": "image/jpeg",
};

// Uploads every file in dir (recursively) under keyPrefix. Returns keys.
export async function uploadDir(dir: string, keyPrefix: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  const keys: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const abs = join(entry.parentPath ?? (entry as any).path, entry.name);
    const rel = abs.slice(dir.length + 1);
    const key = `${keyPrefix}/${rel}`;
    const ext = entry.name.slice(entry.name.lastIndexOf("."));
    await uploadFile(abs, key, CONTENT_TYPES[ext]);
    keys.push(key);
  }
  return keys;
}
