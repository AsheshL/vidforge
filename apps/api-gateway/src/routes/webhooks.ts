import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { QueueEventType, type JobQueueServiceClient, type Webhook } from "@vidforge/proto/jobs";
import { requireRole } from "../auth.js";

// Public event names — the same ones delivered payloads carry in `type`
// (packages/webhooks deliver.ts). PROGRESS is not deliverable by webhook.
const EVENT_NAMES = {
  "job.enqueued": QueueEventType.QUEUE_EVENT_TYPE_ENQUEUED,
  "job.started": QueueEventType.QUEUE_EVENT_TYPE_STARTED,
  "job.completed": QueueEventType.QUEUE_EVENT_TYPE_COMPLETED,
  "job.failed": QueueEventType.QUEUE_EVENT_TYPE_FAILED,
  "job.retrying": QueueEventType.QUEUE_EVENT_TYPE_RETRYING,
} as const;
type EventName = keyof typeof EVENT_NAMES;
const NAME_BY_TYPE = new Map<QueueEventType, string>(
  Object.entries(EVENT_NAMES).map(([name, type]) => [type, name]),
);

const registerSchema = z.object({
  url: z.string().url().max(2048),
  events: z
    .array(z.enum(Object.keys(EVENT_NAMES) as [EventName, ...EventName[]]))
    .min(1),
});

// gRPC status → HTTP. jobs-svc reports URL/event validation failures
// (private targets, http in production, …) as INVALID_ARGUMENT.
const GRPC_HTTP: Record<number, number> = { 3: 400, 5: 404, 7: 403, 16: 401 };

function toHttp(w: Webhook) {
  return {
    webhookId: w.webhookId,
    url: w.url,
    events: w.events.map((e) => NAME_BY_TYPE.get(e)).filter(Boolean),
    signingSecretHint: w.signingSecretHint,
    active: w.active,
  };
}

// Webhook management, backed by jobs-svc. The plaintext signing secret is
// only ever present in the POST response body — like API keys, it is never
// logged and never readable again.
export function registerWebhookRoutes(app: FastifyInstance, jobsClient: JobQueueServiceClient) {
  app.get("/v1/org/webhooks", { preHandler: requireRole("ADMIN") }, async (req, reply) => {
    return new Promise((resolve) => {
      jobsClient.listWebhooks({ context: req.authContext! }, (err, res) => {
        if (err) {
          resolve(reply.code(GRPC_HTTP[err.code] ?? 502).send({ error: err.details || err.message }));
        } else {
          resolve(reply.send({ webhooks: res.webhooks.map(toHttp) }));
        }
      });
    });
  });

  app.post("/v1/org/webhooks", { preHandler: requireRole("ADMIN") }, async (req, reply) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return new Promise((resolve) => {
      jobsClient.registerWebhook(
        {
          context: req.authContext!,
          url: parsed.data.url,
          events: [...new Set(parsed.data.events)].map((e) => EVENT_NAMES[e]),
        },
        (err, res) => {
          if (err) {
            resolve(reply.code(GRPC_HTTP[err.code] ?? 502).send({ error: err.details || err.message }));
          } else {
            resolve(reply.code(201).send({ ...toHttp(res), signingSecret: res.signingSecret }));
          }
        },
      );
    });
  });

  app.delete("/v1/org/webhooks/:webhookId", { preHandler: requireRole("ADMIN") }, async (req, reply) => {
    const { webhookId } = req.params as { webhookId: string };
    return new Promise((resolve) => {
      jobsClient.deleteWebhook({ context: req.authContext!, webhookId }, (err, res) => {
        if (err) {
          resolve(reply.code(GRPC_HTTP[err.code] ?? 502).send({ error: err.details || err.message }));
        } else {
          resolve(reply.send(res));
        }
      });
    });
  });
}
