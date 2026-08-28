import type { RawEmail } from "./fixtures";

/* ============================================================
   Deterministic parsing.

   Split into two independent questions, because they fail
   differently:

     identifyPlatform()  — WHO sent this? Sender domain only.
                           Near-perfect, cheap, no false positives.
     classifyIntent()    — WHAT is it? Phrase matching on subject/body.
                           Good on templates, weak on human prose.

   Anything that comes out with low confidence goes to the LLM instead.
   The rule throughout: prefer returning nothing over returning a
   guess. A wrong company invents an application that never existed,
   and the monthly count is what the enforcement engine stands on.
   ============================================================ */

export type Platform =
  | "linkedin" | "indeed" | "workday" | "greenhouse" | "lever" | "ashby"
  | "smartrecruiters" | "icims" | "reed" | "totaljobs" | "direct" | "other";

export type EmailKind =
  | "confirmation" | "progress" | "assessment" | "interview" | "offer"
  | "rejection" | "recruiter_outreach" | "job_alert" | "noise" | "unknown";

export interface ParseResult {
  kind: EmailKind;
  confidence: number;
  parserId: string;
  platform: Platform;
  company?: string;
  role?: string;
  location?: string;
  actionAt?: Date;
  actionLabel?: string;
}

/** Below this, the email is handed to the LLM rather than trusted. */
export const TRUST_THRESHOLD = 0.75;

/** Real mail is hard-wrapped at ~72 chars, so any multi-word phrase can
 *  be split by a newline mid-sentence. Every prose match runs against
 *  the flattened text; only line-structured templates use the raw body. */
const flat = (s: string) => s.replace(/\s+/g, " ").trim();
const CLEAN = (s: string) => flat(s).replace(/[.,;:]+$/, "").trim();

/* ---------------- sender ---------------- */

export function senderAddress(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).trim().toLowerCase();
}

export function senderName(from: string): string {
  const m = from.match(/^\s*"?([^"<]+?)"?\s*</);
  return m ? m[1].trim() : "";
}

/** Role-account senders speak for a company; a person's address doesn't. */
const ROLE_ACCOUNT =
  /^(no-?reply|noreply|donotreply|do-not-reply|jobs|careers?|earlycareers|talent|recruit\w*|hiring|people|hr|alert|notification|mailer|info|hello|team|apply|application)/i;

function isPersonalSender(addr: string): boolean {
  return !ROLE_ACCOUNT.test(addr.split("@")[0] ?? "");
}

/** Third-party assessment vendors. The sender is the vendor, never the
 *  employer, so the company has to come out of the body. */
const ASSESSMENT_VENDOR =
  /@(?:[\w-]+\.)?(shl|hackerrank|codility|testgorilla|hirevue|imocha|criteriacorp|arctic-?shores|cut-?e)\.com$/i;

const GENERIC_DOMAIN =
  /^(?:mail\.|email\.|careers?\.|jobs\.|recruiting\.|talent\.|hire\.)?(gmail|googlemail|outlook|hotmail|yahoo|icloud|proton\w*|linkedin|indeed\w*|greenhouse|greenhouse-mail|lever|ashbyhq|myworkday|smartrecruiters|icims|reed|totaljobs|medium|slc|teamtailor-mail)\./i;

function companyFromDomain(addr: string): string | undefined {
  const domain = addr.split("@")[1] ?? "";
  if (GENERIC_DOMAIN.test(domain)) return undefined;
  const base = domain.replace(/^(?:mail|email|careers?|jobs|recruiting|talent|hire|no-reply)\./i, "");
  const first = base.split(".")[0];
  if (!first || first.length < 2) return undefined;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

/* ---------------- who sent it ---------------- */

interface PlatformRule {
  platform: Platform;
  test: (addr: string) => boolean;
  /** Job-alert senders are separated here, at the sender level, because
   *  that is the only reliable discriminator: LinkedIn's alert mail and
   *  its application confirmations are otherwise near-identical. */
  alwaysNoise?: (addr: string) => boolean;
}

const PLATFORM_RULES: PlatformRule[] = [
  {
    platform: "linkedin",
    test: (a) => a.endsWith("@linkedin.com"),
    alwaysNoise: (a) => a.startsWith("jobalerts-") || a.startsWith("jobs-listings@"),
  },
  {
    platform: "indeed",
    test: (a) => a.endsWith("@indeed.com") || a.endsWith("@indeedemail.com"),
    alwaysNoise: (a) => a.startsWith("alert@") || a.startsWith("invitetoapply@"),
  },
  { platform: "workday", test: (a) => a.endsWith("@myworkday.com") || a.includes(".myworkday.") },
  { platform: "greenhouse", test: (a) => a.endsWith("@greenhouse.io") || a.includes("greenhouse-mail.io") },
  { platform: "lever", test: (a) => a.endsWith("@hire.lever.co") || a.endsWith("@lever.co") },
  { platform: "ashby", test: (a) => a.endsWith("@ashbyhq.com") },
  { platform: "smartrecruiters", test: (a) => a.endsWith("@smartrecruiters.com") },
  { platform: "icims", test: (a) => a.includes("icims.com") },
  { platform: "reed", test: (a) => a.endsWith("@reed.co.uk") },
  { platform: "totaljobs", test: (a) => a.endsWith("@totaljobs.com") },
];

export function identifyPlatform(email: RawEmail): { platform: Platform; noise: boolean } {
  const addr = senderAddress(email.from);
  for (const rule of PLATFORM_RULES) {
    if (rule.test(addr)) {
      return { platform: rule.platform, noise: rule.alwaysNoise?.(addr) ?? false };
    }
  }
  return { platform: "other", noise: false };
}

/* ---------------- what it is ---------------- */

/* Ordered by how decisive each signal is. Rejection outranks
 * confirmation because rejection mail routinely opens by thanking you
 * for applying; interview outranks assessment because an interview
 * invitation often mentions a prior test. */
const INTENT_RULES: Array<{ kind: EmailKind; weight: number; phrases: RegExp[] }> = [
  {
    kind: "rejection", weight: 0.92,
    phrases: [
      /not (?:be )?(?:progress|proceed)ing/i,
      /move forward with other candidate/i,
      /decided (?:not )?to (?:move forward|proceed|progress)/i,
      /unsuccessful (?:on this occasion|this time|at this stage)/i,
      /will not be taking your application/i,
      /pursu(?:e|ing) other candidate/i,
      /gone with (?:someone|another candidate)/i,
      /not (?:been )?(?:selected|successful)/i,
    ],
  },
  {
    kind: "interview", weight: 0.9,
    phrases: [
      /interview (?:is )?(?:confirmed|scheduled|booked)/i,
      /invite you to (?:an? )?(?:onsite |video |final |first )?interview/i,
      /interview invitation/i,
      /schedule (?:your|an) interview/i,
    ],
  },
  {
    kind: "assessment", weight: 0.88,
    phrases: [
      /assessment (?:is ready|invitation|for you)/i,
      /invited you to (?:take|complete|start)\b/i,
      /complete (?:your|the) (?:online )?(?:test|assessment|challenge)/i,
      /coding (?:test|challenge)/i,
      /online (?:test|assessment)\b/i,
    ],
  },
  {
    kind: "offer", weight: 0.9,
    phrases: [/pleased to offer you/i, /offer of employment/i, /we would like to offer/i],
  },
  {
    kind: "progress", weight: 0.8,
    phrases: [
      /move (?:you )?(?:on )?to the next (?:stage|round)/i,
      /shortlisted/i,
      /your (?:cv|application) is with the hiring team/i,
      /(?:would )?love to move you/i,
      /moved to screening/i,
      /progress(?:ing|ed) (?:you|your application) to/i,
    ],
  },
  {
    kind: "confirmation", weight: 0.85,
    phrases: [
      /your application was sent to/i,
      /thank(?:s| you) for (?:applying|your application)/i,
      /application (?:has been )?received/i,
      /we (?:have )?(?:got|received) your application/i,
      /application acknowledgement/i,
      /acknowledge receipt of your application/i,
      /you applied to/i,
      /application (?:has been )?submitted/i,
      /landed safely/i,
    ],
  },
  {
    kind: "recruiter_outreach", weight: 0.86,
    phrases: [
      /came across your profile/i,
      /i(?:'m| am) recruiting for/i,
      /would you be open to a (?:quick )?chat/i,
      /i have (?:several|a few|some) .{0,40}(?:roles|positions|opportunities)/i,
      /are you still looking/i,
    ],
  },
  {
    kind: "job_alert", weight: 0.84,
    phrases: [
      /\bjobs? for you\b/i,
      /new jobs? (?:for|in|matching)/i,
      /your job alert/i,
      /\d+\+? new .{0,30}jobs?\b/i,
      /and \d+ more jobs?/i,
    ],
  },
];

export function classifyIntent(email: RawEmail): { kind: EmailKind; confidence: number } {
  const hay = flat(`${email.subject} \n ${email.body}`);
  for (const rule of INTENT_RULES) {
    if (rule.phrases.some((p) => p.test(hay))) {
      return { kind: rule.kind, confidence: rule.weight };
    }
  }
  return { kind: "unknown", confidence: 0 };
}

/* ---------------- field extraction ---------------- */

/** Strips the debris that turns a good role into a bad dedupe key:
 *  trailing company names, requisition numbers, the word "role", and
 *  the leading fragments that greedy patterns pick up. */
function cleanRole(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let r = flat(raw)
    .replace(/\s*\([^)]*\)\s*$/, "")               // "(R-104882)"
    .replace(/\s+\b(?:at|with|for)\s+[A-Z].*$/, "") // "... at Monzo landed safely"
    .replace(/\s+\b(?:role|position|vacancy|opening)\b.*$/i, "")
    .replace(/^(?:the|a|an)\s+/i, "")
    .replace(/[.,;:]+$/, "")
    .trim();

  // Guards against the classic greedy captures.
  if (/^(?:interest|your|our|this|that|application|receipt|position of)\b/i.test(r)) return undefined;
  if (r.length < 3 || r.length > 70) return undefined;
  return r;
}

function extractCompany(email: RawEmail, platform: Platform, kind: EmailKind): string | undefined {
  const name = senderName(email.from);
  const addr = senderAddress(email.from);
  const text = flat(email.body);

  // Assessment vendors speak for someone else — the employer is in the body.
  if (ASSESSMENT_VENDOR.test(addr)) {
    const m = text.match(/\b([A-Z][\w&.' -]{1,30}?)\s+(?:has\s+)?invited you to/);
    if (m) return CLEAN(m[1]);
  }

  if (platform === "linkedin") {
    const m = email.subject.match(/application was sent to\s+(.+)$/i);
    if (m) return CLEAN(m[1]);
  }

  if (platform === "indeed") {
    const m = email.body.match(/you applied to:?\s*\n+\s*.+\n+\s*([^\n—-]+)/i);
    if (m) return CLEAN(m[1]);
    const inline = text.match(/you applied to .+? at\s+([^.]+)/i);
    if (inline) return CLEAN(inline[1]);
  }

  if (platform === "workday") {
    if (name) return CLEAN(name.replace(/\s+(?:careers?|group|recruiting|talent)$/i, ""));
    const local = addr.split("@")[0];
    if (local) return CLEAN(local.replace(/[._-]+/g, " "));
  }

  /* A person's display name is a person, not an employer — that is how
   * "Rhian Powell" ended up as a company. For personal senders the
   * domain is the only trustworthy signal. */
  if (isPersonalSender(addr)) {
    const prose = text.match(/\b(?:role|position)\s+at\s+([A-Z][\w&.' -]{1,40})/);
    return prose ? CLEAN(prose[1]) : companyFromDomain(addr);
  }

  if (name && !/^(linkedin|indeed|greenhouse|lever|ashby|shl|hackerrank|codility)/i.test(name)) {
    return CLEAN(name.replace(/\s+(?:careers?|recruiting|talent|team|hiring)$/i, ""));
  }

  const prose =
    text.match(/\b(?:role|position)\s+at\s+([A-Z][\w&.' -]{1,40})/) ||
    text.match(/\bapplying to\s+(?:the\s+)?(?:.{0,60}?\s+)?at\s+([A-Z][\w&.' -]{1,40})/);
  if (prose) return CLEAN(prose[1]);

  return kind === "confirmation" ? companyFromDomain(addr) : undefined;
}

function extractRole(email: RawEmail, platform: Platform): string | undefined {
  if (platform === "linkedin") {
    const lines = email.body.split("\n").map((l) => l.trim());
    const idx = lines.findIndex((l) => /application was sent to/i.test(l));
    if (idx >= 0) {
      const next = lines.slice(idx + 1).find((l) => l.length > 0);
      if (next) return cleanRole(next);
    }
  }

  if (platform === "indeed") {
    const m = email.body.match(/you applied to:?\s*\n+\s*([^\n]+)/i);
    if (m) return cleanRole(m[1]);
    const subj = email.subject.match(/indeed application:\s*(.+)$/i);
    if (subj) return cleanRole(subj[1]);
  }

  const text = flat(email.body);
  /* Ordered most-specific first. "interest in the X role" has to come
   * before the generic "the X role" form, or the greedy version
   * captures "interest in the X". */
  const patterns = [
    /interest in (?:the )?(.+?)\s+(?:role|position|vacancy|opening)\b/i,
    /assessment for the\s+(.+?)\s+role\b/i,
    /application for (?:the )?(?:position of\s+)?(.+?)(?:\s*\(|\s+at\s+|,\s*based|\.|$)/i,
    /appl(?:ying|ied) (?:to|for) (?:the )?(.+?)\s+(?:role|position)\b/i,
    /appl(?:ying|ied) (?:to|for) (?:the )?(.+?)(?:\s*\(|\s+at\s+[A-Z]|\.|$)/i,
    /\b(?:interview|test|assessment) for (?:the )?(.+?)(?:\s+at\s+|\s+role\b|\.|$)/i,
    /next stage for\s+(.+?)(?:\.|$)/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    const role = cleanRole(m?.[1]);
    if (role) return role;
  }

  /* Personal replies often carry the role only in the subject line:
   * "Re: BI Developer, Junior". Only accept a subject that reads like a
   * job title — anything containing a verb is a sentence *about* a
   * role, not the role itself ("Sky invited you to a test"). */
  const subj = cleanRole(email.subject.replace(/^\s*(?:re|fw|fwd)\s*:\s*/i, ""));
  const sentenceLike =
    /\b(?:you|your|we|us|our|is|are|has|have|invited?|invites?|thanks?|update|received|ready|application)\b/i;
  if (subj && !sentenceLike.test(subj)) return subj;

  return undefined;
}

/** A place name, not the sentence it sits in. Both of these ran on past
 *  the location and swallowed the next clause — "Location: London
 *  Bridge. We will review and be in touch" became the location. Stop at
 *  a sentence boundary, and cap the length: a real place name is short,
 *  and anything long is a sign the pattern has overrun. */
function cleanLocation(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const loc = flat(raw)
    .split(/[.;|]|\s{2,}/)[0]        // stop at the end of the sentence
    .replace(/\s*\([^)]*\)\s*$/, "")  // "(Hybrid)"
    .replace(/[,\s]+$/, "")
    .trim();
  if (!loc || loc.length < 2 || loc.length > 40) return undefined;
  if (/\b(?:we|you|your|will|are|is|please|applications?)\b/i.test(loc)) return undefined;
  return loc;
}

function extractLocation(email: RawEmail): string | undefined {
  const explicit = cleanLocation(email.body.match(/^\s*location:\s*([^\n]+)/im)?.[1]);
  if (explicit) return explicit;

  // LinkedIn: "Monzo · London, England, United Kingdom (Hybrid)"
  const dot = cleanLocation(
    email.body.match(/·\s*([A-Z][\w .'-]+?),\s*(?:England|Scotland|Wales)/)?.[1],
  );
  if (dot) return dot;

  return cleanLocation(flat(email.body).match(/based in\s+([A-Z][\w .'-]{2,40})/)?.[1]);
}

/** Only accept dates that parse to something real inside a sane window;
 *  anything else is left for a human rather than guessed at. */
function parseWhen(raw: string | undefined): Date | undefined {
  if (!raw) return undefined;
  const t = Date.parse(raw.trim());
  if (Number.isNaN(t)) return undefined;
  const d = new Date(t);
  const days = (d.getTime() - Date.now()) / 864e5;
  return days > -400 && days < 400 ? d : undefined;
}

function extractActionAt(email: RawEmail, kind: EmailKind): { at?: Date; label?: string } {
  if (kind === "assessment") {
    const text = flat(email.body);
    const m =
      text.match(/(?:complete by|complete before|expires? on|expiry date|deadline):?\s*([A-Za-z0-9 ,]+?\d{4})/i) ||
      text.match(/invitation expires on\s+([A-Za-z0-9 ,]+?\d{4})/i);
    const at = parseWhen(m?.[1]);
    return at ? { at, label: "Assessment deadline" } : {};
  }

  if (kind === "interview") {
    /* Interview lines look like "When: Thu Sep 11 2026 at 14:30 BST" or
     * "Date: Mon Sep 15 2026, 10:00". Pull the line, then find the date
     * and the time in it separately — trailing timezones otherwise
     * break a single combined pattern. */
    const line = email.body.match(/^\s*(?:when|date|starts?|scheduled for)\s*:\s*(.+)$/im)?.[1];
    if (line) {
      const time = line.match(/\b(\d{1,2}):(\d{2})\b/);
      const datePart = line
        .replace(/\s*\bat\b.*$/i, "")
        .replace(/,\s*\d{1,2}:\d{2}.*$/, "")
        .replace(/\s+[A-Z]{2,4}\s*$/, "")
        .trim();
      const at = parseWhen(datePart);
      if (at) {
        if (time) at.setHours(Number(time[1]) || 0, Number(time[2]) || 0, 0, 0);
        return { at, label: "Interview" };
      }
    }
  }
  return {};
}

/* ---------------- the parse ---------------- */

export function parseEmail(email: RawEmail): ParseResult {
  const { platform, noise } = identifyPlatform(email);

  // Sender-level noise is decisive and skips intent entirely: a
  // LinkedIn job alert reads exactly like a confirmation.
  if (noise) {
    return { kind: "job_alert", confidence: 0.97, parserId: `${platform}.jobalert`, platform };
  }

  const { kind, confidence } = classifyIntent(email);

  if (kind === "unknown") {
    return { kind: "unknown", confidence: 0, parserId: "none", platform };
  }

  if (kind === "job_alert" || kind === "noise" || kind === "recruiter_outreach") {
    return { kind, confidence, parserId: `generic.${kind}`, platform };
  }

  const company = extractCompany(email, platform, kind);
  const role = extractRole(email, platform);
  const location = extractLocation(email);
  const { at, label } = extractActionAt(email, kind);

  /* A known ATS raises confidence because its templates are stable.
   * Missing a company drops it hard — an application with no company is
   * worse than no application. A missing role only matters on a
   * confirmation; follow-up mail rarely restates it, and those attach
   * to an existing application by thread instead. */
  let score = confidence;
  if (platform !== "other") score = Math.min(0.98, score + 0.08);
  if (!company) score -= 0.35;
  if (!role && kind === "confirmation") score -= 0.15;

  return {
    kind,
    confidence: Math.max(0, Math.round(score * 100) / 100),
    parserId: `${platform}.${kind}`,
    platform,
    company,
    role,
    location,
    actionAt: at,
    actionLabel: label,
  };
}

/** Normalised join key for deduplication and resolution. */
export function dedupeKey(company: string, role: string): string {
  const norm = (s: string) =>
    s.toLowerCase()
      .replace(/\b(ltd|limited|plc|inc|llc|group|technology|technologies|uk)\b/g, "")
      .replace(/[^a-z0-9]+/g, "");
  return `${norm(company)}|${norm(role)}`;
}
