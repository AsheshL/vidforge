import type { FastifyBaseLogger } from "fastify";
import { Redis as IORedis } from "ioredis";

/**
 * Fastify's `trustProxy` setting, read from TRUST_PROXY.
 *
 * Accepts "true", a hop count ("1"), or a comma-separated list of trusted
 * proxy IPs/CIDRs. Anything falsy leaves it off, which is the right default
 * for a directly reachable gateway: trusting X-Forwarded-For when nothing
 * sets it lets a caller spoof their IP and walk around the auth rate limits.
 */
export function parseTrustProxy(raw: string | undefined): boolean | number | string {
  const value = raw?.trim();
  if (!value || value === "false" || value === "0") return false;
  if (value === "true") return true;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

/**
 * Redis connection backing the rate limiter, so the limits are a fleet-wide
 * budget rather than per-replica (N gateway tasks with the default in-process
 * store means N x the configured limit).
 *
 * Tuned to fail fast: a Redis outage must not turn into request latency.
 * With `enableOfflineQueue` off the commands reject immediately rather than
 * queueing behind a dead connection, and the limiter is registered with
 * `skipOnError` so those rejections serve the request unlimited.
 */
export function createRateLimitRedis(log: FastifyBaseLogger): IORedis | null {
  const url = process.env.RATE_LIMIT_REDIS_URL ?? process.env.REDIS_URL;
  if (!url) {
    log.warn("no REDIS_URL — rate limits fall back to per-process counters");
    return null;
  }

  const redis = new IORedis(url, {
    connectTimeout: 500,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  // ioredis throws on an unhandled 'error' event; the limiter degrades on its
  // own, so log and carry on rather than taking the gateway down with it.
  // ioredis retries forever, so only the first failure of an outage is logged
  // — otherwise a Redis restart buries the logs under reconnect attempts.
  let reported = false;
  redis.on("error", (err) => {
    if (reported) return;
    reported = true;
    log.warn({ err }, "rate-limit redis unavailable — limits are off until it returns");
  });
  redis.on("ready", () => {
    if (reported) log.info("rate-limit redis reconnected");
    reported = false;
  });
  return redis;
}
