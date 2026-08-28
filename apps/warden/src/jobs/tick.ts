import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "@/db";
import { applications, dailyLog, notices, settings, witnesses } from "@/db/schema";
import { computeState } from "@/lib/data";
import { heartbeatEmail, witnessEmail } from "@/lib/notices";
import { isConfigured, isPlaceholder, sendMail, MailError } from "@/lib/mailer";

/* ============================================================
   The nightly tick.

   Decides what the ladder owes today and, if armed, sends it.

   Three properties this has to have, because it emails other people
   unattended:

   1. Idempotent. Cron double-fires, servers reboot mid-run, someone
      runs it by hand to see what it does. The notices table is the
      guard: a witness is emailed at most once per run of misses.
   2. Fails closed. Unarmed, unconfigured, or pointed at a placeholder
      address means nothing sends — never a best guess.
   3. Derives state from the record, not from a counter. If the job does
      not run for three days, the next run still sees the truth rather
      than a stale increment.
   ============================================================ */

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Weekly, but not on a fixed weekday — six days is the guard so a
 *  reboot cannot skip a week or double up. */
const HEARTBEAT_EVERY_DAYS = 6;

export interface PlannedNotice {
  kind: "witness_email" | "heartbeat";
  witnessId: number;
  witness: string;
  to: string;
  subject: string;
  body: string;
  blocked?: string;
}

export interface TickReport {
  now: Date;
  armed: boolean;
  smtpConfigured: boolean;
  dryRun: boolean;
  consecutiveMisses: number;
  monthDone: number;
  monthlyTarget: number;
  floor: number;
  loggedToday: number;
  planned: PlannedNotice[];
  sent: string[];
  skipped: string[];
  errors: string[];
}

export async function tick(opts: { dryRun?: boolean; now?: Date } = {}): Promise<TickReport> {
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun ?? true;

  const { engine, cfg, people, lastAppliedAt, consecutiveMisses } = await computeState(now);

  const report: TickReport = {
    now,
    armed: cfg.armed,
    smtpConfigured: isConfigured(),
    dryRun,
    consecutiveMisses,
    monthDone: engine.monthDone,
    monthlyTarget: engine.monthlyTarget,
    floor: engine.floor,
    loggedToday: engine.loggedToday,
    planned: [],
    sent: [],
    skipped: [],
    errors: [],
  };

  /* The current run of misses began the day after the last application.
   * Anything already sent since then belongs to this run and must not
   * be repeated; anything older belongs to a previous run. */
  const runStart = lastAppliedAt ?? new Date(0);

  const ladder = [...people].sort((a, b) => a.triggerDay - b.triggerDay);

  for (const w of ladder) {
    if (consecutiveMisses < w.triggerDay) continue;

    const [already] = await db
      .select({ id: notices.id })
      .from(notices)
      .where(
        and(
          eq(notices.kind, "witness_email"),
          eq(notices.witnessId, w.id),
          gte(notices.firedAt, runStart),
        ),
      )
      .limit(1);
    if (already) {
      report.skipped.push(`${w.name}: already told during this run`);
      continue;
    }

    const [everSent] = await db
      .select({ id: notices.id })
      .from(notices)
      .where(and(eq(notices.kind, "witness_email"), eq(notices.witnessId, w.id)))
      .limit(1);

    const next = ladder.find((x) => x.triggerDay > consecutiveMisses);

    const mail = witnessEmail({
      witness: w.name,
      user: cfg.userName,
      engine,
      firstContact: !everSent,
      nextWitnessIn: next ? next.triggerDay - consecutiveMisses : null,
    });

    report.planned.push({
      kind: "witness_email",
      witnessId: w.id,
      witness: w.name,
      to: w.email,
      subject: mail.subject,
      body: mail.text,
      blocked: isPlaceholder(w.email) ? "placeholder address" : undefined,
    });
  }

  /* Heartbeat. Its whole value is that its absence is noticeable, so it
   * goes out whether or not anything is escalating. */
  const heartbeatPeople = people.filter((w) => w.heartbeat);
  if (heartbeatPeople.length) {
    const cutoff = new Date(now.getTime() - HEARTBEAT_EVERY_DAYS * 864e5);
    const [recent] = await db
      .select({ id: notices.id })
      .from(notices)
      .where(and(eq(notices.kind, "heartbeat"), gte(notices.firedAt, cutoff)))
      .limit(1);

    if (!recent) {
      const [{ n: weekCount }] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(applications)
        .where(gte(applications.appliedAt, new Date(now.getTime() - 7 * 864e5)));

      for (const w of heartbeatPeople) {
        const mail = heartbeatEmail({ witness: w.name, user: cfg.userName, weekCount, engine });
        report.planned.push({
          kind: "heartbeat",
          witnessId: w.id,
          witness: w.name,
          to: w.email,
          subject: mail.subject,
          body: mail.text,
          blocked: isPlaceholder(w.email) ? "placeholder address" : undefined,
        });
      }
    } else {
      report.skipped.push(`heartbeat: sent within the last ${HEARTBEAT_EVERY_DAYS} days`);
    }
  }

  /* Record what today looked like regardless of sending — the daily log
   * is the history of what the floor actually was. Message and state are
   * left alone; the Today screen owns those. */
  const day = ymd(now);
  await db
    .insert(dailyLog)
    .values({
      day,
      logged: engine.loggedToday,
      floor: engine.floor,
      requiredRate: engine.requiredRate,
      cleared: engine.floorCleared,
    })
    .onConflictDoUpdate({
      target: dailyLog.day,
      set: {
        logged: engine.loggedToday,
        floor: engine.floor,
        requiredRate: engine.requiredRate,
        cleared: engine.floorCleared,
      },
    });

  // ---- gates ----
  if (dryRun) return report;
  if (!cfg.armed) {
    report.skipped.push("not armed — nothing sent (settings.armed is false)");
    return report;
  }
  if (!isConfigured()) {
    report.errors.push("SMTP is not configured — nothing sent");
    return report;
  }

  for (const p of report.planned) {
    if (p.blocked) {
      report.errors.push(`${p.witness}: ${p.blocked} — not sent`);
      continue;
    }
    try {
      await sendMail({ to: p.to, subject: p.subject, text: p.body });
      // Recorded only after a successful send, so a crash mid-loop
      // retries rather than silently swallowing the notice.
      await db.insert(notices).values({
        kind: p.kind,
        rung: p.kind === "witness_email" ? consecutiveMisses : null,
        witnessId: p.witnessId,
        body: p.body,
      });
      report.sent.push(`${p.kind} -> ${p.witness} <${p.to}>`);
    } catch (e) {
      const msg = e instanceof MailError ? e.message : (e as Error).message;
      report.errors.push(`${p.witness}: ${msg}`);
    }
  }

  return report;
}

/** Turning the ladder on. Refuses while any active witness still has a
 *  placeholder address — an armed bluff is worse than an unarmed one. */
export async function arm(on: boolean): Promise<{ ok: boolean; reason?: string }> {
  if (on) {
    const people = await db.select().from(witnesses).where(eq(witnesses.active, true));
    if (people.length === 0) return { ok: false, reason: "no active witnesses" };
    const bad = people.filter((w) => isPlaceholder(w.email));
    if (bad.length) {
      return { ok: false, reason: `placeholder addresses: ${bad.map((w) => `${w.name} <${w.email}>`).join(", ")}` };
    }
    if (!isConfigured()) return { ok: false, reason: "SMTP is not configured" };
  }
  await db.update(settings).set({ armed: on, updatedAt: new Date() }).where(eq(settings.id, 1));
  return { ok: true };
}
