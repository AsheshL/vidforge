import { createTransport } from "nodemailer";

// Dev default points at Mailpit from docker-compose (UI on :8025).
const transport = createTransport(
  process.env.SMTP_URL ?? "smtp://localhost:1025",
);

const FROM = process.env.MAIL_FROM ?? "VidForge <no-reply@vidforge.local>";

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
