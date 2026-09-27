import { expect, type APIRequestContext } from "@playwright/test";
import { MAILPIT_URL } from "./env.js";

interface MailSummary {
  ID: string;
  To: { Address: string }[];
  Subject: string;
}

// Waits for the newest message to `address` and returns its plain-text body.
export async function waitForMail(request: APIRequestContext, address: string, timeoutMs = 20_000) {
  let found: MailSummary | undefined;
  await expect
    .poll(
      async () => {
        const res = await request.get(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`);
        if (!res.ok()) return false;
        found = ((await res.json()).messages as MailSummary[])[0];
        return !!found;
      },
      { timeout: timeoutMs, message: `no email to ${address} in Mailpit (${MAILPIT_URL})` },
    )
    .toBe(true);
  const msg = await (await request.get(`${MAILPIT_URL}/api/v1/message/${found!.ID}`)).json();
  return { subject: found!.Subject, text: msg.Text as string };
}

export function tempPasswordFrom(text: string): string {
  const match = /Temporary password:\s*(\S+)/.exec(text);
  expect(match, "invite email carries a temporary password").not.toBeNull();
  return match![1];
}
