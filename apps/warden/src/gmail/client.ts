import type { RawEmail } from "@/pipeline/fixtures";

/* ============================================================
   Gmail REST client.

   The narrowing happens in Gmail's own search, not in our code. That is
   the cheapest tier of the funnel: a query that excludes 90% of a
   mailbox costs one API call, where fetching everything and filtering
   locally costs one call per message and a lot of quota.
   ============================================================ */

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

export class GmailError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "GmailError";
  }
}

/* Senders that carry application mail, plus the subject shapes that
 * catch employers mailing direct from their own domain. Overridable via
 * GMAIL_QUERY when a new ATS shows up. */
const ATS_SENDERS = [
  "greenhouse.io", "greenhouse-mail.io", "myworkday.com", "hire.lever.co",
  "ashbyhq.com", "smartrecruiters.com", "icims.com", "linkedin.com",
  "indeed.com", "indeedemail.com", "reed.co.uk", "totaljobs.com",
  "teamtailor-mail.com", "workable.com", "jobvite.com", "breezy.hr",
  "shl.com", "hackerrank.com", "codility.com", "testgorilla.com", "hirevue.com",
];

const SUBJECT_HINTS = [
  '"your application"', '"thank you for applying"', '"application received"',
  '"application was sent"', '"application submitted"', '"application update"',
  "interview", "assessment", "shortlisted",
];

export function defaultQuery(days: number): string {
  if (process.env.GMAIL_QUERY) return process.env.GMAIL_QUERY;
  const from = ATS_SENDERS.map((d) => `from:${d}`).join(" OR ");
  const subj = SUBJECT_HINTS.map((s) => `subject:${s}`).join(" OR ");
  return `newer_than:${days}d -in:spam -in:trash -in:chats (${from} OR ${subj})`;
}

async function call<T>(accessToken: string, path: string, attempt = 0): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (res.status === 429 || res.status >= 500) {
    if (attempt < 4) {
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      return call<T>(accessToken, path, attempt + 1);
    }
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new GmailError(`Gmail ${res.status} on ${path.split("?")[0]}: ${body.slice(0, 200)}`, res.status);
  }
  return res.json() as Promise<T>;
}

interface ListResponse {
  messages?: Array<{ id: string; threadId: string }>;
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

/** Walks every page of a search. `cap` stops a first-ever sync from
 *  pulling a decade of mail in one go. */
export async function listMessageIds(
  accessToken: string,
  query: string,
  cap = 500,
): Promise<Array<{ id: string; threadId: string }>> {
  const out: Array<{ id: string; threadId: string }> = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({ q: query, maxResults: "100" });
    if (pageToken) params.set("pageToken", pageToken);
    const page = await call<ListResponse>(accessToken, `/messages?${params}`);
    out.push(...(page.messages ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken && out.length < cap);

  return out.slice(0, cap);
}

interface MessagePart {
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { data?: string; size?: number };
  parts?: MessagePart[];
}

interface GmailMessage {
  id: string;
  threadId: string;
  snippet?: string;
  internalDate?: string;
  payload?: MessagePart;
}

export async function getMessage(accessToken: string, id: string): Promise<GmailMessage> {
  return call<GmailMessage>(accessToken, `/messages/${id}?format=full`);
}

const b64url = (data: string) => Buffer.from(data, "base64url").toString("utf8");

function header(msg: GmailMessage, name: string): string {
  const h = msg.payload?.headers?.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h?.value ?? "";
}

/** HTML-only mail is common. Crude is fine — the parsers work on
 *  phrases, and what matters is that the words survive in reading
 *  order with line structure roughly intact. */
function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Depth-first walk for the readable body. text/plain wins outright;
 *  HTML is the fallback, stripped. Attachments are skipped. */
function extractBody(part: MessagePart | undefined): string {
  if (!part) return "";

  const plain: string[] = [];
  const html: string[] = [];

  const walk = (p: MessagePart) => {
    if (p.filename) return; // attachment
    const mime = p.mimeType ?? "";
    if (mime === "text/plain" && p.body?.data) plain.push(b64url(p.body.data));
    else if (mime === "text/html" && p.body?.data) html.push(b64url(p.body.data));
    p.parts?.forEach(walk);
  };
  walk(part);

  if (plain.length) return plain.join("\n").trim();
  if (html.length) return htmlToText(html.join("\n"));
  return "";
}

/** Maps a Gmail message into the same shape the fixtures use, so the
 *  parsing and ingest path is identical whether mail came from the API
 *  or from disk. */
export function toRawEmail(msg: GmailMessage, account: string): RawEmail {
  const receivedAt = msg.internalDate
    ? new Date(Number(msg.internalDate)).toISOString()
    : new Date().toISOString();

  return {
    gmailId: msg.id,
    threadId: msg.threadId,
    account,
    from: header(msg, "From"),
    to: header(msg, "To") || account,
    subject: header(msg, "Subject"),
    receivedAt,
    snippet: msg.snippet ?? "",
    // Bodies get truncated: signal is in the opening, and legal
    // footers are pure storage and token cost.
    body: extractBody(msg.payload).slice(0, 20_000),
  };
}
