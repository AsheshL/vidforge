import { createHmac, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface Delivery {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
  event: { id: string; type: string; createdAt: string; data: { jobId: string; assetId: string; attempt: number; detail: string } };
}

// Independent implementation of the documented scheme
// (`vidforge-signature: t=<unix>,v1=<hex HMAC-SHA256 of "t.body">`), so the
// test checks the contract receivers rely on, not the sender's own helper.
export function signatureValid(secret: string, body: string, header: string | undefined): boolean {
  const parts = Object.fromEntries((header ?? "").split(",").map((p) => p.split("=", 2) as [string, string]));
  if (!parts.t || !parts.v1) return false;
  const expected = createHmac("sha256", secret).update(`${parts.t}.${body}`).digest();
  const given = Buffer.from(parts.v1, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// A local receiver. `statusFor` scripts responses per path; `nth` counts
// deliveries of the same event to the same path, so 1 is the first attempt
// and 2+ are retries.
export async function startReceiver(statusFor: (path: string, nth: number) => number = () => 200) {
  const deliveries: Delivery[] = [];
  const hits = new Map<string, number>();
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const path = req.url ?? "/";
      const event = JSON.parse(body);
      const key = `${path} ${event.id}`;
      const nth = (hits.get(key) ?? 0) + 1;
      hits.set(key, nth);
      deliveries.push({ path, headers: req.headers, body, event });
      res.writeHead(statusFor(path, nth)).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: (path: string) => `http://127.0.0.1:${port}${path}`,
    deliveries,
    forJob: (jobId: string, path?: string) =>
      deliveries.filter((d) => d.event.data.jobId === jobId && (!path || d.path === path)),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
