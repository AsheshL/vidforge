import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "vidforge-signature";

// How far a signature's timestamp may drift from the receiver's clock
// before verifyWebhookSignature rejects it as a possible replay.
export const DEFAULT_TOLERANCE_SECONDS = 300;

function hmac(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

// `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`. The timestamp is
// inside the signed string so a captured delivery can't be replayed later
// with a fresh timestamp. Every delivery attempt is signed anew.
export function signWebhookPayload(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)): string {
  return `t=${timestamp},v1=${hmac(secret, timestamp, body)}`;
}

// The receiver-side check, exported so tests and any first-party consumer
// verify exactly the scheme the sender uses.
export function verifyWebhookSignature(
  secret: string,
  body: string,
  header: string,
  { toleranceSeconds = DEFAULT_TOLERANCE_SECONDS, now = Math.floor(Date.now() / 1000) } = {},
): boolean {
  const parts = new Map(
    header.split(",").map((p) => {
      const i = p.indexOf("=");
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()] as const;
    }),
  );
  const timestamp = Number(parts.get("t"));
  const signature = parts.get("v1");
  if (!Number.isInteger(timestamp) || !signature) return false;
  if (Math.abs(now - timestamp) > toleranceSeconds) return false;

  const expected = Buffer.from(hmac(secret, timestamp, body), "hex");
  const given = Buffer.from(signature, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
