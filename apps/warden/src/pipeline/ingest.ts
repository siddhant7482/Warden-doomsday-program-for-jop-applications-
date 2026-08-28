import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { accounts, applications, emails } from "@/db/schema";
import type { RawEmail } from "./fixtures";
import { parseEmail, dedupeKey, TRUST_THRESHOLD, type EmailKind, type ParseResult } from "./parse";
import { triageEmail } from "./llm";

/* ============================================================
   Ingestion.

   Emails in, applications out. Three jobs, in order:

     1. classify  — what is this? (parse.ts)
     2. resolve   — which application does it belong to?
     3. apply     — move that application's state forward

   Resolution is the part that actually decides whether the numbers are
   true. One application throws off five or six emails across separate
   threads, often from a shared ATS sender where the company appears
   only in the body. Attaching them wrongly either splits one
   application into three or merges two into one — both corrupt the
   count the enforcement engine runs on.
   ============================================================ */

/** Emails that say something about a real application. Everything else
 *  is stored for auditability but never touches an application. */
const APPLICATION_BEARING: EmailKind[] = [
  "confirmation", "progress", "assessment", "interview", "offer", "rejection",
];

/** How far a status can advance. Rejection is terminal and always wins —
 *  a rejection routinely arrives after an "in review" note. */
type Status =
  | "applied" | "in_review" | "assessment" | "interview" | "offer"
  | "accepted" | "rejected" | "ghosted" | "withdrawn";

const RANK: Partial<Record<Status, number>> = {
  applied: 1, in_review: 2, assessment: 3, interview: 4, offer: 5, accepted: 6,
};
const TERMINAL = new Set<Status>(["rejected", "accepted", "withdrawn"]);

function nextStatus(current: Status, kind: EmailKind): Status {
  if (kind === "rejection") return "rejected";
  // A terminal verdict is not walked back by a stray later email.
  if (TERMINAL.has(current)) return current;

  const incoming: Partial<Record<EmailKind, Status>> = {
    confirmation: "applied",
    progress: "in_review",
    assessment: "assessment",
    interview: "interview",
    offer: "offer",
  };
  const want = incoming[kind];
  if (!want) return current;

  // Ghosted applications come back to life the moment someone writes.
  if (current === "ghosted") return want;
  return (RANK[want] ?? 0) > (RANK[current] ?? 0) ? want : current;
}

export interface IngestReport {
  seen: number;
  skipped: number;
  stored: number;
  needsLLM: number;
  applicationsCreated: number;
  applicationsTouched: number;
  duplicatesFolded: number;
  unresolved: number;
  llmResolved: number;
  llmErrors: string[];
  byKind: Record<string, number>;
}

/** Attach an email to an existing application, or decide it starts one.
 *  Ordered strongest signal first; returns null when nothing is
 *  confident enough, which flags the row for review rather than
 *  guessing. */
async function resolve(
  raw: RawEmail,
  p: ParseResult,
  accountId: number,
): Promise<{ applicationId: number | null; created: boolean; duplicate: boolean }> {
  // 1. Same Gmail thread as an email we have already placed. Strongest
  //    signal there is — a reply chain is unambiguous.
  if (raw.threadId) {
    const sibling = await db
      .select({ id: emails.applicationId })
      .from(emails)
      .where(and(eq(emails.threadId, raw.threadId), sql`${emails.applicationId} is not null`))
      .limit(1);
    if (sibling[0]?.id) return { applicationId: sibling[0].id, created: false, duplicate: false };
  }

  // 2. Exact company + role match.
  if (p.company && p.role) {
    const key = dedupeKey(p.company, p.role);
    const hit = await db
      .select({ id: applications.id })
      .from(applications)
      .where(eq(applications.dedupeKey, key))
      .limit(1);

    if (hit[0]) {
      // A second confirmation for a key we already hold is a
      // re-application, not a new job. Folding it here is what stops
      // the monthly count double-counting.
      return { applicationId: hit[0].id, created: false, duplicate: p.kind === "confirmation" };
    }

    if (p.kind === "confirmation") {
      const inserted = await db
        .insert(applications)
        .values({
          company: p.company,
          role: p.role,
          location: p.location ?? null,
          platform: p.platform,
          accountId,
          url: null,
          status: "applied",
          appliedAt: new Date(raw.receivedAt),
          lastContactAt: new Date(raw.receivedAt),
          dedupeKey: key,
        })
        .returning({ id: applications.id });
      return { applicationId: inserted[0].id, created: true, duplicate: false };
    }
  }

  // 3. Company known but role missing — common on third-party assessment
  //    mail ("Sky invited you to a test", role nowhere in the body).
  //    Only safe when the company has exactly one open application.
  if (p.company) {
    const norm = dedupeKey(p.company, "").split("|")[0];
    const live = await db
      .select({ id: applications.id })
      .from(applications)
      .where(
        and(
          sql`split_part(${applications.dedupeKey}, '|', 1) = ${norm}`,
          inArray(applications.status, ["applied", "in_review", "assessment", "interview", "offer"]),
        ),
      )
      .limit(2);
    if (live.length === 1) return { applicationId: live[0].id, created: false, duplicate: false };
  }

  // 4. Not confident. Flag it rather than invent something.
  return { applicationId: null, created: false, duplicate: false };
}

export interface IngestOptions {
  /** Send emails the pattern parsers could not read to the model.
   *  Off by default so a run without a key behaves identically. */
  useLLM?: boolean;
}

export async function ingest(raws: RawEmail[], opts: IngestOptions = {}): Promise<IngestReport> {
  const report: IngestReport = {
    seen: raws.length, skipped: 0, stored: 0, needsLLM: 0,
    applicationsCreated: 0, applicationsTouched: 0, duplicatesFolded: 0,
    unresolved: 0, llmResolved: 0, llmErrors: [], byKind: {},
  };

  const accountRows = await db.select().from(accounts);
  const accountByEmail = new Map(accountRows.map((a) => [a.email, a.id]));

  /* Chronological order matters: a confirmation has to create the
   * application before the rejection three weeks later tries to attach
   * to it. Out of order, every follow-up lands unresolved. */
  const ordered = [...raws].sort(
    (a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt),
  );

  for (const raw of ordered) {
    const accountId = accountByEmail.get(raw.account);
    if (!accountId) throw new Error(`unknown account: ${raw.account}`);

    // The unique index makes this idempotent, but checking first keeps
    // the report honest about what a re-run actually did.
    const existing = await db
      .select({ id: emails.id })
      .from(emails)
      .where(and(eq(emails.accountId, accountId), eq(emails.gmailId, raw.gmailId)))
      .limit(1);
    if (existing[0]) { report.skipped++; continue; }

    let p = parseEmail(raw);
    let parsedBy: "pattern" | "llm" = "pattern";

    /* Only what the deterministic parsers could not read reaches the
     * model. If it comes back no more confident, the pattern verdict
     * stands and the row is flagged rather than overwritten. */
    if (p.confidence < TRUST_THRESHOLD) {
      report.needsLLM++;
      if (opts.useLLM) {
        const t = await triageEmail(raw, p.platform);
        if (t.result && t.result.confidence > p.confidence) {
          p = t.result;
          parsedBy = "llm";
          report.llmResolved++;
        } else if (t.error) {
          report.llmErrors.push(`${raw.gmailId}: ${t.error}`);
        }
      }
    }

    report.byKind[p.kind] = (report.byKind[p.kind] || 0) + 1;
    const trusted = p.confidence >= TRUST_THRESHOLD;

    let applicationId: number | null = null;

    // Only application-bearing mail we actually trust gets to move state.
    if (trusted && APPLICATION_BEARING.includes(p.kind)) {
      const r = await resolve(raw, p, accountId);
      applicationId = r.applicationId;
      if (r.created) report.applicationsCreated++;
      if (r.duplicate) report.duplicatesFolded++;

      if (applicationId) {
        report.applicationsTouched++;
        const [app] = await db
          .select()
          .from(applications)
          .where(eq(applications.id, applicationId))
          .limit(1);

        const received = new Date(raw.receivedAt);
        const status = nextStatus(app.status as Status, p.kind);

        await db
          .update(applications)
          .set({
            status,
            lastContactAt: received > app.lastContactAt ? received : app.lastContactAt,
            // Only assessments and interviews ever demand action.
            nextActionAt: p.actionAt ?? app.nextActionAt,
            nextActionLabel: p.actionLabel ?? app.nextActionLabel,
            location: app.location ?? p.location ?? null,
            updatedAt: new Date(),
          })
          .where(eq(applications.id, applicationId));
      } else {
        report.unresolved++;
      }
    }

    await db.insert(emails).values({
      accountId,
      gmailId: raw.gmailId,
      threadId: raw.threadId,
      fromAddr: raw.from,
      fromName: raw.from.replace(/\s*<[^>]+>/, "").trim() || null,
      subject: raw.subject,
      receivedAt: new Date(raw.receivedAt),
      snippet: raw.snippet,
      body: raw.body,
      kind: p.kind,
      parsedBy,
      parserId: p.parserId,
      confidence: p.confidence,
      extracted: {
        company: p.company ?? null,
        role: p.role ?? null,
        location: p.location ?? null,
        actionAt: p.actionAt?.toISOString() ?? null,
      },
      applicationId,
      unresolved: trusted && APPLICATION_BEARING.includes(p.kind) && !applicationId,
    });
    report.stored++;
  }

  return report;
}

/** Silence past the threshold is a verdict, not a gap. Runs after every
 *  ingest so nothing sits in the pipeline pretending to be alive. */
export async function sweepGhosts(ghostDays: number): Promise<number> {
  const cutoff = new Date(Date.now() - ghostDays * 864e5);
  const res = await db
    .update(applications)
    .set({ status: "ghosted", updatedAt: new Date() })
    .where(
      and(
        inArray(applications.status, ["applied", "in_review"]),
        lt(applications.lastContactAt, cutoff),
      ),
    )
    .returning({ id: applications.id });
  return res.length;
}
