import nodemailer, { type Transporter } from "nodemailer";

/* ============================================================
   Outbound mail.

   This is the only part of Warden that reaches a real person who is not
   the user. Everything here is built to fail closed: unconfigured means
   nothing sends, unarmed means nothing sends, and a placeholder address
   is refused outright rather than quietly bouncing.

   The asymmetry that matters: not sending is a missed nudge. Sending
   wrongly is an email to someone's friend that cannot be recalled.
   ============================================================ */

export class MailError extends Error {}

/** Addresses that exist only because the seed script had to put
 *  something in the column. Sending to these means the witnesses were
 *  never actually set up, which means the ladder is a bluff. */
const PLACEHOLDER = /@(?:example\.(?:com|org|net)|test|localhost|invalid)$/i;

export function isPlaceholder(address: string): boolean {
  return PLACEHOLDER.test(address.trim());
}

export function isConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

let cached: Transporter | null = null;

function transport(): Transporter {
  if (cached) return cached;
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) {
    throw new MailError("SMTP_HOST, SMTP_USER and SMTP_PASS must be set to send mail.");
  }
  const port = Number(process.env.SMTP_PORT ?? 587);
  cached = nodemailer.createTransport({
    host,
    port,
    // 465 is implicit TLS; 587 upgrades via STARTTLS.
    secure: port === 465,
    auth: { user, pass },
  });
  return cached;
}

export interface Outgoing {
  to: string;
  subject: string;
  text: string;
}

export async function sendMail(msg: Outgoing): Promise<string> {
  if (isPlaceholder(msg.to)) {
    throw new MailError(
      `Refusing to send to ${msg.to} — that is a placeholder address. ` +
        `Set the witnesses' real addresses before arming the ladder.`,
    );
  }
  const from = process.env.SMTP_FROM || process.env.SMTP_USER!;
  const info = await transport().sendMail({
    from: `Warden <${from}>`,
    to: msg.to,
    subject: msg.subject,
    text: msg.text,
  });
  return String(info.messageId ?? "sent");
}

/** Proves the credentials work without emailing anybody. */
export async function verifyConnection(): Promise<void> {
  await transport().verify();
}
