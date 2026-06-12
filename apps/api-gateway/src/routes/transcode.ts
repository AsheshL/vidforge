import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { VideoServiceClient } from "@vidforge/proto/video";
import { requireRole } from "../auth.js";

const renditionSchema = z.object({
  name: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  videoBitrateKbps: z.number().int().positive(),
  audioBitrateKbps: z.number().int().positive(),
});

const submitSchema = z.object({
  sourceStorageKey: z.string().min(1),
  renditions: z.array(renditionSchema).min(1).max(8),
  hlsSegmentSeconds: z.number().int().min(2).max(20).default(6),
  generateThumbnails: z.boolean().default(false),
  priority: z.number().int().min(0).max(10).default(0),
  idempotencyKey: z.string().optional(),
});

export function registerTranscodeRoutes(app: FastifyInstance, videoClient: VideoServiceClient) {
  app.post("/v1/assets/:assetId/transcode", { preHandler: requireRole("EDITOR") }, async (req, reply) => {
    const { assetId } = req.params as { assetId: string };
    const parsed = submitSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const body = parsed.data;

    return new Promise((resolve) => {
      videoClient.submitTranscodeJob(
        {
          context: req.authContext!,
          assetId,
          sourceStorageKey: body.sourceStorageKey,
          profile: {
            renditions: body.renditions.map((r) => ({
              ...r,
              videoCodec: 1, // H264
              audioCodec: 1, // AAC
              framerate: 0,
            })),
            packaging: 1, // HLS
            hlsSegmentSeconds: body.hlsSegmentSeconds,
            generateThumbnails: body.generateThumbnails,
            thumbnailIntervalSeconds: 10,
            burnInSubtitleAssetId: "",
          },
          priority: body.priority,
          idempotencyKey: body.idempotencyKey ?? "",
        },
        (err, res) => {
          if (err) {
            resolve(reply.code(502).send({ error: err.details || err.message }));
          } else {
            resolve(reply.code(202).send({ jobId: res.jobId, state: res.state }));
          }
        },
      );
    });
  });

  app.get("/v1/jobs", { preHandler: requireRole("VIEWER") }, async (req, reply) => {
    const { assetId, pageSize, pageToken } = req.query as {
      assetId?: string;
      pageSize?: string;
      pageToken?: string;
    };
    const size = Math.min(Math.max(Number(pageSize) || 50, 1), 100);
    return new Promise((resolve) => {
      videoClient.listJobs(
        {
          context: req.authContext!,
          page: { pageSize: size, pageToken: pageToken ?? "" },
          assetId: assetId ?? "",
          stateFilter: 0,
        },
        (err, res) => {
          if (err) {
            resolve(reply.code(502).send({ error: err.details || err.message }));
          } else {
            resolve(reply.send(res));
          }
        },
      );
    });
  });

  app.get("/v1/jobs/:jobId", { preHandler: requireRole("VIEWER") }, async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    return new Promise((resolve) => {
      videoClient.getJob({ context: req.authContext!, jobId }, (err, res) => {
        if (err) {
          resolve(reply.code(err.code === 5 ? 404 : 502).send({ error: err.details || err.message }));
        } else {
          resolve(reply.send(res));
        }
      });
    });
  });

  // Creator-or-admin checks live in video-svc; the gateway only authenticates.
  app.post("/v1/jobs/:jobId/cancel", { preHandler: requireRole("VIEWER") }, async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    return new Promise((resolve) => {
      videoClient.cancelJob({ context: req.authContext!, jobId }, (err, res) => {
        if (err) {
          const code = err.code === 5 ? 404 : err.code === 7 ? 403 : err.code === 9 ? 409 : 502;
          resolve(reply.code(code).send({ error: err.details || err.message }));
        } else {
          resolve(reply.send(res));
        }
      });
    });
  });

  app.delete("/v1/jobs/:jobId", { preHandler: requireRole("VIEWER") }, async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    return new Promise((resolve) => {
      videoClient.deleteJob({ context: req.authContext!, jobId }, (err, res) => {
        if (err) {
          const code = err.code === 5 ? 404 : err.code === 7 ? 403 : err.code === 9 ? 409 : 502;
          resolve(reply.code(code).send({ error: err.details || err.message }));
        } else {
          resolve(reply.send(res));
        }
      });
    });
  });

  // Bridges the gRPC server-stream to SSE for the dashboard.
  app.get("/v1/jobs/:jobId/events", { preHandler: requireRole("VIEWER") }, (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    const stream = videoClient.streamProgress({ context: req.authContext!, jobId });
    stream.on("data", (event) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    stream.on("end", () => reply.raw.end());
    stream.on("error", (err) => {
      reply.raw.write(`event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`);
      reply.raw.end();
    });
    req.raw.on("close", () => stream.cancel());
  });
}
