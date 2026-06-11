import { randomUUID } from "node:crypto";
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Server } from "@tus/server";
import { S3Store } from "@tus/s3-store";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@vidforge/db";
import { requireRole } from "../auth.js";

const BUCKET = process.env.S3_BUCKET ?? "vidforge-media";

const s3Config = {
  region: process.env.S3_REGION ?? "us-east-1",
  endpoint: process.env.S3_ENDPOINT ?? "http://localhost:9000",
  forcePathStyle: true, // required for MinIO
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY ?? "vidforge",
    secretAccessKey: process.env.S3_SECRET_KEY ?? "vidforge-secret",
  },
};

const s3 = new S3Client(s3Config);

const tusServer = new Server({
  path: "/v1/uploads",
  datastore: new S3Store({ s3ClientConfig: { bucket: BUCKET, ...s3Config } }),
  // Flat unguessable key: it doubles as the claim ticket for /register.
  namingFunction: () => `tus-${randomUUID()}`,
  respectForwardedHeaders: true,
});

const registerSchema = z.object({
  uploadKey: z.string().regex(/^tus-[0-9a-f-]{36}$/),
  title: z.string().min(1).max(200),
});

export function registerUploadRoutes(app: FastifyInstance) {
  // tus PATCH bodies are raw octet streams; leave them unconsumed so the
  // tus server can read them from the underlying request.
  app.addContentTypeParser("application/offset+octet-stream", (_req, _payload, done) => done(null));

  const handler = { preHandler: requireRole("EDITOR") };
  const proxy = (req: { raw: unknown }, reply: { raw: unknown; hijack: () => void }) => {
    reply.hijack();
    void tusServer.handle(req.raw as never, reply.raw as never);
  };
  app.all("/v1/uploads", handler, proxy);
  app.all("/v1/uploads/*", handler, proxy);

  // Claims a finished tus upload as an asset in the caller's org. The key
  // is an unguessable UUID returned only to the uploader, so possession
  // proves the upload is theirs.
  app.post("/v1/assets/register", handler, async (req, reply) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const { uploadKey, title } = parsed.data;

    let size = 0;
    try {
      const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: uploadKey }));
      size = head.ContentLength ?? 0;
    } catch {
      return reply.code(404).send({ error: "no completed upload with this key" });
    }
    const existing = await prisma.asset.findFirst({ where: { sourceStorageKey: uploadKey } });
    if (existing) {
      return reply.code(409).send({ error: "this upload is already registered" });
    }

    const asset = await prisma.asset.create({
      data: {
        orgId: req.authContext!.orgId,
        title,
        createdBy: req.authContext!.userId,
        status: "UPLOADED",
        sourceStorageKey: uploadKey,
        sourceBytes: size,
      },
    });
    return reply.code(201).send({ assetId: asset.id, sourceStorageKey: uploadKey });
  });
}
