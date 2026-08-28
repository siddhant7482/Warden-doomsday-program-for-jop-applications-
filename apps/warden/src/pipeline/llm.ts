import { z } from "zod";
import { chatJson, MODELS, hasKey, OpenRouterError } from "@/lib/openrouter";
import type { RawEmail } from "./fixtures";
import type { EmailKind, ParseResult, Platform } from "./parse";

/* ============================================================
   The messy tail.

   Only sees what the deterministic parsers could not read — roughly 7%
   of volume on the fixture corpus. That ratio is the point: templated
   ATS mail is parsed by code that cannot hallucinate, and the model is
   reserved for human prose, unknown ATSs, and politely-worded
   rejections that never use the word.

   The prompt carries the same rule the parsers do: returning null is
   always better than guessing. A wrong company creates an application
   that never existed, and the monthly count is what the entire
   enforcement engine stands on.
   ============================================================ */

const KINDS = [
  "confirmation", "progress", "assessment", "interview", "offer",
  "rejection", "recruiter_outreach", "job_alert", "noise",
] as const;

/* Models occasionally rename a field to match the prose that described
 * it — "CLASSIFY into a kind" reliably produced `classification`
 * instead of `kind`. The prompt now shows the exact shape, which fixes
 * it at source; this stays as a cheap safety net, because a renamed key
 * should not cost a whole email. */
const KIND_ALIASES = ["classification", "category", "type", "email_kind", "label"];

const TriageSchema = z.preprocess((value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const o = { ...(value as Record<string, unknown>) };
  if (o.kind === undefined) {
    const alias = KIND_ALIASES.find((k) => o[k] !== undefined);
    if (alias) o.kind = o[alias];
  }
  return o;
}, z.object({
  kind: z.enum(KINDS),
  company: z.string().min(1).max(80).nullable(),
  role: z.string().min(2).max(80).nullable(),
  location: z.string().max(80).nullable(),
  /** ISO 8601, or null. Only for assessment deadlines and interviews. */
  action_at: z.string().nullable(),
  action_label: z.string().max(40).nullable(),
  confidence: z.number().min(0).max(1),
  why: z.string().max(400),
}));

export type Triage = z.infer<typeof TriageSchema>;

const SYSTEM = `You read one email from a job-seeker's inbox and classify it.

Your output feeds a counter that a person's daily routine is enforced against.
A wrong answer invents an application that never happened, or hides one that
did. Both corrupt it. Returning null is ALWAYS better than guessing.

CLASSIFY into exactly one kind:
  confirmation       They applied and this acknowledges receipt.
  progress           Moving forward: shortlisted, next stage, under review.
  assessment         A test/assessment to complete, usually with a deadline.
  interview          An interview being offered, scheduled or confirmed.
  offer              An actual job offer.
  rejection          Not proceeding. Often polite and never uses the word
                     "reject" — "gone with someone whose experience...",
                     "decided to move forward with other candidates".
  recruiter_outreach A recruiter approaching THEM about a role they did NOT
                     apply to. Names a company and a role, reads like good
                     news, and is NOT an application. This one matters.
  job_alert          Automated listings digest. "10 new jobs for you."
                     NOT an application, however many companies it names.
  noise              Anything else: newsletters, bills, unrelated mail.

The two most costly mistakes, in order:
  1. Counting a job_alert or recruiter_outreach as a confirmation. This
     silently inflates the count and tells them they are doing more than
     they are.
  2. Inventing a company or role that is not literally in the email.

EXTRACT only what is explicitly stated:
  company      The EMPLOYER. Not the ATS (Greenhouse, Workday, Lever), not the
               assessment vendor (SHL, HackerRank), not the recruitment agency,
               and never a person's name. Null if not clearly stated.
  role         The job title only. Not "the Data Analyst role at Monzo" — just
               "Data Analyst". Strip requisition numbers. Null if absent.
  location     City or region if stated. Null otherwise.
  action_at    ISO 8601 datetime, ONLY for an assessment deadline or an
               interview time. Null for everything else.
  action_label "Assessment deadline" or "Interview". Null otherwise.
  confidence   0-1, your honest read. Below 0.7 means a human should look.
  why          One short sentence on what decided it.

OUTPUT — reply with this exact JSON object and these exact key names.
Do not rename a key. Do not nest. Do not add keys. Do not wrap it in
anything. Use null, not "null" or "unknown", for anything absent.

{
  "kind": "confirmation|progress|assessment|interview|offer|rejection|recruiter_outreach|job_alert|noise",
  "company": "string or null",
  "role": "string or null",
  "location": "string or null",
  "action_at": "ISO 8601 datetime or null",
  "action_label": "Assessment deadline, Interview, or null",
  "confidence": 0.0,
  "why": "one short sentence"
}`;

function buildUser(email: RawEmail): string {
  // Bodies are truncated: the signal is in the opening lines, and long
  // legal footers are pure token cost.
  return [
    `From: ${email.from}`,
    `Subject: ${email.subject}`,
    `Received: ${email.receivedAt}`,
    "",
    email.body.slice(0, 4000),
  ].join("\n");
}

export interface TriageOutcome {
  result: ParseResult | null;
  triage: Triage | null;
  error?: string;
}

/** Reads one email with the model and returns it in the same shape the
 *  pattern parsers produce, so the ingest path stays identical. */
export async function triageEmail(
  email: RawEmail,
  platform: Platform = "other",
): Promise<TriageOutcome> {
  if (!hasKey()) return { result: null, triage: null, error: "no OPENROUTER_API_KEY" };

  try {
    const t = await chatJson(
      {
        model: MODELS.triage(),
        system: SYSTEM,
        user: buildUser(email),
        maxTokens: 500,
        temperature: 0, // classification, not writing
      },
      TriageSchema,
    );

    let actionAt: Date | undefined;
    if (t.action_at) {
      const parsed = new Date(t.action_at);
      // Reject anything the model dreamt up outside a sane window.
      const days = (parsed.getTime() - Date.now()) / 864e5;
      if (!Number.isNaN(parsed.getTime()) && days > -400 && days < 400) actionAt = parsed;
    }

    return {
      triage: t,
      result: {
        kind: t.kind as EmailKind,
        confidence: t.confidence,
        parserId: `llm.${MODELS.triage()}`,
        platform,
        company: t.company ?? undefined,
        role: t.role ?? undefined,
        location: t.location ?? undefined,
        actionAt,
        actionLabel: t.action_label ?? undefined,
      },
    };
  } catch (e) {
    const msg = e instanceof OpenRouterError ? e.message : String(e);
    // A model failure must never take the ingest down — the email is
    // stored unparsed and can be re-run later.
    return { result: null, triage: null, error: msg };
  }
}
