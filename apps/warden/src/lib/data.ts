import { and, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { applications, dailyLog, escalation, settings, witnesses } from "@/db/schema";
import { compute, stateLabel, type EngineOutput } from "./engine";
import { composeMessage } from "./voice";

/* Read models for the two views. Everything the screens need is
 * assembled here so the pages stay declarative. */

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);

export const LIVE_STATUSES = ["applied", "in_review", "assessment", "interview", "offer"] as const;
const NEEDS_YOU = ["assessment", "interview"] as const;

async function getSettings() {
  const [s] = await db.select().from(settings).limit(1);
  if (s) return s;
  const [created] = await db.insert(settings).values({ id: 1 }).returning();
  return created;
}

async function getEscalation() {
  const [e] = await db.select().from(escalation).limit(1);
  if (e) return e;
  const [created] = await db.insert(escalation).values({ id: 1 }).returning();
  return created;
}

async function countSince(since: Date) {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(applications)
    .where(gte(applications.appliedAt, since));
  return r?.n ?? 0;
}

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/* One message per day per state. Cached in daily_log so opening the
 * page twice doesn't spend a second API call — but regenerated the
 * moment the state moves, because clearing the floor has to change the
 * voice with it. The previous five are fed back in so thirty
 * consecutive mornings never rhyme. */
async function dailyMessage(now: Date, engine: EngineOutput, tone: number) {
  const day = ymd(now);

  const [existing] = await db.select().from(dailyLog).where(eq(dailyLog.day, day)).limit(1);
  if (existing?.message && existing.state === engine.state) {
    return { text: existing.message, generated: existing.generated };
  }

  const recent = await db
    .select({ message: dailyLog.message })
    .from(dailyLog)
    .where(isNotNull(dailyLog.message))
    .orderBy(desc(dailyLog.day))
    .limit(5);

  const { text, generated } = await composeMessage({
    engine,
    recent: recent.map((r) => r.message!).filter(Boolean),
    tone,
  });

  const row = {
    day,
    logged: engine.loggedToday,
    floor: engine.floor,
    requiredRate: engine.requiredRate,
    cleared: engine.floorCleared,
    message: text,
    state: engine.state,
    generated,
  };
  await db.insert(dailyLog).values(row).onConflictDoUpdate({ target: dailyLog.day, set: row });

  return { text, generated };
}

export interface TodayModel {
  engine: EngineOutput;
  chip: string;
  message: string;
  meta: string;
  ladder: Array<{ day: number; label: string; state: "past" | "now" | "future" }>;
  needsYou: { company: string; role: string; label: string; when: Date } | null;
  needsYouCount: number;
  awaitingReply: number;
  interviewsBooked: number;
}

/* Shared by the Today screen and the nightly job. Deliberately does not
 * generate the daily message — the job runs unattended and must not
 * spend an API call just to decide whether to send an email. */
export async function computeState(now = new Date()) {
  const cfg = await getSettings();
  const esc = await getEscalation();
  const people = await db.select().from(witnesses).where(eq(witnesses.active, true));

  const monthDone = await countSince(startOfMonth(now));
  const loggedToday = await countSince(startOfDay(now));

  /* Consecutive misses is derived from the record rather than trusted
   * from a counter: whole days since the last application, so it stays
   * true even if a nightly job never ran. */
  const [last] = await db
    .select({ at: applications.appliedAt })
    .from(applications)
    .orderBy(desc(applications.appliedAt))
    .limit(1);
  const consecutiveMisses = last
    ? Math.max(0, Math.floor((startOfDay(now).getTime() - startOfDay(last.at).getTime()) / 864e5))
    : 0;

  const engine = compute({
    now,
    monthlyTarget: cfg.monthlyTarget,
    floorFraction: cfg.floorFraction,
    restDayMultiple: cfg.restDayMultiple,
    monthDone,
    loggedToday,
    consecutiveMisses,
    restDaysBanked: esc.restDaysBanked,
    witnesses: people.map((w) => ({ name: w.name, triggerDay: w.triggerDay })),
  });

  return { engine, cfg, esc, people, lastAppliedAt: last?.at ?? null, consecutiveMisses };
}

export async function getToday(now = new Date()): Promise<TodayModel> {
  const { engine, cfg, people, consecutiveMisses } = await computeState(now);

  const ladder: TodayModel["ladder"] = [
    { day: 1, label: "Notification" },
    { day: 2, label: "Full screen" },
    { day: 3, label: "Warning" },
    ...people
      .slice()
      .sort((a, b) => a.triggerDay - b.triggerDay)
      .map((w) => ({ day: w.triggerDay, label: w.name })),
  ].map((r) => ({
    ...r,
    state:
      r.day < consecutiveMisses ? ("past" as const)
      : r.day === consecutiveMisses ? ("now" as const)
      : ("future" as const),
  }));

  const [top] = await db
    .select()
    .from(applications)
    .where(and(inArray(applications.status, [...NEEDS_YOU]), isNotNull(applications.nextActionAt)))
    .orderBy(applications.nextActionAt)
    .limit(1);

  const [{ n: needsYouCount }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(applications)
    .where(inArray(applications.status, [...NEEDS_YOU]));

  const [{ n: awaitingReply }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(applications)
    .where(inArray(applications.status, ["applied", "in_review"]));

  const [{ n: interviewsBooked }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(applications)
    .where(eq(applications.status, "interview"));

  const { text: message } = await dailyMessage(now, engine, cfg.tone);

  return {
    engine,
    chip: stateLabel(engine.state),
    message,
    meta: `${now.toLocaleDateString("en-GB", { day: "2-digit", month: "short" }).toUpperCase()} · CYCLE ${engine.dayOfMonth} / ${engine.daysInMonth}`,
    ladder,
    needsYou: top && top.nextActionAt
      ? { company: top.company, role: top.role, label: top.nextActionLabel ?? "Action", when: top.nextActionAt }
      : null,
    needsYouCount,
    awaitingReply,
    interviewsBooked,
  };
}

/* ---------------- pipeline ---------------- */

export type PipelineFilter = "all" | "need" | "live" | "dead";

export interface PipelineRow {
  id: number;
  company: string;
  role: string;
  location: string | null;
  salaryRaw: string | null;
  platform: string;
  appliedAt: Date;
  status: string;
  url: string | null;
  nextActionAt: Date | null;
  nextActionLabel: string | null;
  silentDays: number;
  group: "need" | "live" | "dead";
}

export interface PipelineModel {
  rows: PipelineRow[];
  counts: { all: number; need: number; live: number; dead: number };
  funnel: {
    applied: number; replied: number; rejected: number;
    ghosted: number; live: number; interviews: number;
    repliedPct: number; rejectedPct: number; interviewPct: number;
    since: Date | null;
  };
  attention: PipelineRow[];
  ghostDays: number;
}

function groupOf(status: string): "need" | "live" | "dead" {
  if (status === "assessment" || status === "interview") return "need";
  if (status === "rejected" || status === "ghosted" || status === "withdrawn") return "dead";
  return "live";
}

export async function getPipeline(filter: PipelineFilter = "all"): Promise<PipelineModel> {
  const cfg = await getSettings();
  const all = await db.select().from(applications).orderBy(desc(applications.appliedAt));

  const rows: PipelineRow[] = all.map((a) => ({
    id: a.id,
    company: a.company,
    role: a.role,
    location: a.location,
    salaryRaw: a.salaryRaw,
    platform: a.platform,
    appliedAt: a.appliedAt,
    status: a.status,
    url: a.url,
    nextActionAt: a.nextActionAt,
    nextActionLabel: a.nextActionLabel,
    silentDays: Math.max(0, Math.floor((Date.now() - a.lastContactAt.getTime()) / 864e5)),
    group: groupOf(a.status),
  }));

  const counts = {
    all: rows.length,
    need: rows.filter((r) => r.group === "need").length,
    live: rows.filter((r) => r.group === "live").length,
    dead: rows.filter((r) => r.group === "dead").length,
  };

  /* "Replied" means they said something — a rejection is a reply.
   * Ghosted is the only true silence, which is why it earns its own
   * column and the alarm colour. */
  const ghosted = rows.filter((r) => r.status === "ghosted").length;
  const rejected = rows.filter((r) => r.status === "rejected").length;
  const interviews = rows.filter((r) => r.status === "interview").length;
  const applied = rows.length;
  const replied = applied - ghosted - rows.filter((r) => r.status === "applied").length;

  const pct = (n: number) => (applied ? Math.round((n / applied) * 1000) / 10 : 0);

  const attention = rows
    .filter((r) => r.group === "need" && r.nextActionAt)
    .sort((a, b) => a.nextActionAt!.getTime() - b.nextActionAt!.getTime());

  return {
    rows: filter === "all" ? rows : rows.filter((r) => r.group === filter),
    counts,
    funnel: {
      applied, replied, rejected, ghosted,
      live: counts.live + counts.need,
      interviews,
      repliedPct: pct(replied),
      rejectedPct: pct(rejected),
      interviewPct: pct(interviews),
      since: all.length ? all[all.length - 1].appliedAt : null,
    },
    attention,
    ghostDays: cfg.ghostDays,
  };
}
