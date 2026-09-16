import { createTransport, type TransportOptions } from "nodemailer";

// Dev default points at Mailpit from docker-compose (UI on :8025). In
// production this is the SES SMTP endpoint, e.g.
// smtps://<smtp-user>:<smtp-password>@email-smtp.eu-west-1.amazonaws.com:465
const SMTP_URL = process.env.SMTP_URL ?? "smtp://localhost:1025";

const FROM = process.env.MAIL_FROM ?? "VidForge <no-reply@vidforge.local>";

export interface SmtpOptions {
  host: string;
  port: number;
  secure: boolean;
  requireTLS: boolean;
  auth?: { user: string; pass: string };
  pool: boolean;
  maxConnections: number;
  rateLimit: number;
  rateDelta: number;
}

/**
 * Turns SMTP_URL into transport options.
 *
 * Nodemailer can take the URL directly, but not alongside the pooling and
 * throttling SES wants: it bills a TLS handshake per connection and rejects
 * anything past the account's per-second send quota, so a burst of invites
 * has to be paced rather than opened all at once.
 */
export function smtpOptions(rawUrl: string): SmtpOptions {
  const url = new URL(rawUrl);
  const secure = url.protocol === "smtps:";
  const auth = url.username
    ? { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) }
    : undefined;

  return {
    host: url.hostname,
    port: Number(url.port) || (secure ? 465 : 587),
    secure,
    // Credentials never cross the wire in the clear: on the STARTTLS port
    // require the upgrade. Dev Mailpit has no auth and no TLS, so it stays
    // exempt rather than every local signup failing.
    requireTLS: !secure && auth !== undefined,
    auth,
    pool: true,
    maxConnections: Number(process.env.MAIL_MAX_CONNECTIONS ?? 5),
    // SES's default quota is 14 messages/second; lower it here if the
    // account's is lower, or raise it once the quota has been lifted.
    rateLimit: Number(process.env.MAIL_RATE_LIMIT ?? 14),
    rateDelta: 1_000,
  };
}

if (process.env.NODE_ENV === "production" && !process.env.MAIL_FROM) {
  console.warn(
    "MAIL_FROM is unset — SES rejects mail from the .local default; set it to a verified identity",
  );
}

const transport = createTransport(smtpOptions(SMTP_URL) as TransportOptions);

export async function sendInviteEmail(opts: {
  to: string;
  displayName: string;
  orgName: string;
  inviterName: string;
  tempPassword: string;
  expiresAt: Date;
  loginUrl: string;
}) {
  const hours = Math.round((opts.expiresAt.getTime() - Date.now()) / 3_600_000);
  await transport.sendMail({
    from: FROM,
    to: opts.to,
    subject: `You've been invited to ${opts.orgName} on VidForge`,
    text: [
      `Hi ${opts.displayName},`,
      ``,
      `${opts.inviterName} invited you to the "${opts.orgName}" organization on VidForge.`,
      ``,
      `Temporary password: ${opts.tempPassword}`,
      ``,
      `Sign in at ${opts.loginUrl} with this email address and the temporary`,
      `password. You'll be asked to choose your own password right away.`,
      ``,
      `This temporary password expires in ${hours} hours. If it lapses,`,
      `ask your admin to invite you again.`,
    ].join("\n"),
  });
}
