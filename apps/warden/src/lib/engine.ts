/* ============================================================
   The enforcement engine.

   Pure functions. No database, no clock of its own — everything is
   passed in, so the whole thing is testable and the UI can render any
   date without lying.

   The design rests on one idea: never nag, just do arithmetic out
   loud. A message can be argued with. A required rate that climbed
   from 3.2 to 4.3 because you did nothing for four days cannot, and it
   is a different number every morning, so it can never habituate the
   way a fixed daily reminder does.
   ============================================================ */

export type WardenState = "clear" | "drift" | "breach" | "terminal";

export interface EngineInput {
  now: Date;
  monthlyTarget: number;
  floorFraction: number;
  restDayMultiple: number;
  /** Applications logged so far this calendar month. */
  monthDone: number;
  /** Applications logged today. */
  loggedToday: number;
  /** Consecutive days the floor was missed. Comes down one rung per
   *  compliant day — never by waiting. */
  consecutiveMisses: number;
  restDaysBanked: number;
  witnesses: Array<{ name: string; triggerDay: number }>;
}

export interface EngineOutput {
  state: WardenState;

  monthDone: number;
  monthlyTarget: number;
  dayOfMonth: number;
  daysInMonth: number;
  daysLeft: number;

  /** Applications per remaining day needed to still hit the target.
   *  Climbs on its own while you slack. This is the whole mechanism. */
  requiredRate: number;
  /** Yesterday's rate, for "3.2 on Monday, 4.3 now". */
  paceDelta: number;

  floor: number;
  loggedToday: number;
  remainingToday: number;
  floorCleared: boolean;

  /** Ahead of, or behind, a flat run-rate to target. */
  aheadBy: number;

  consecutiveMisses: number;
  restDaysBanked: number;
  /** True when today's haul is big enough to bank a rest day. */
  earnsRestDay: boolean;

  /** Who the ladder hits next, and on which miss-day. */
  nextWitness: { name: string; triggerDay: number; missesAway: number } | null;
  /** Witnesses already notified in this run of misses. */
  notified: string[];
  targetMet: boolean;
}

function daysInMonthOf(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}

/** State is driven by consecutive misses, not by how far behind the
 *  monthly number is. Falling behind is recoverable; not showing up at
 *  all is the thing the ladder exists to punish. */
export function stateFor(misses: number): WardenState {
  if (misses <= 0) return "clear";
  if (misses <= 2) return "drift";
  if (misses <= 5) return "breach";
  return "terminal";
}

function rateFor(target: number, done: number, daysLeft: number): number {
  const remaining = Math.max(0, target - done);
  if (remaining === 0) return 0;
  if (daysLeft <= 0) return remaining;
  return remaining / daysLeft;
}

export function compute(input: EngineInput): EngineOutput {
  const {
    now, monthlyTarget, floorFraction, restDayMultiple,
    monthDone, loggedToday, consecutiveMisses, restDaysBanked, witnesses,
  } = input;

  const daysInMonth = daysInMonthOf(now);
  const dayOfMonth = now.getDate();
  const daysLeft = daysInMonth - dayOfMonth + 1; // today counts

  const requiredRate = rateFor(monthlyTarget, monthDone, daysLeft);

  /* What the rate would have been yesterday, with yesterday's total.
   * The gap between the two is the cost of the day you skipped. */
  const yesterdayRate = rateFor(
    monthlyTarget,
    monthDone - loggedToday,
    Math.min(daysInMonth, daysLeft + 1),
  );
  const paceDelta = requiredRate - yesterdayRate;

  const targetMet = monthDone >= monthlyTarget;

  /* The floor is what stops one token application at 11pm clearing the
   * ladder. It scales with the required rate, so it gets harder while
   * you slack and easier once you push ahead — but never drops below 1
   * while there is anything left to do.
   *
   * And it is capped. Late in a blown month the required rate goes
   * vertical (92 left, 4 days = 23/day), and a floor of 23 is not a
   * demand, it is a reason to stop opening the app. An unwinnable
   * system is worse than no system, so the daily ask tops out at twice
   * the flat run-rate: still punishing, still clearable. The monthly
   * number stays honest either way — only the floor is capped. */
  const flatRateForCap = monthlyTarget / daysInMonth;
  const floorCap = Math.max(2, Math.ceil(flatRateForCap * 2));
  const floor = targetMet
    ? 0
    : Math.min(floorCap, Math.max(1, Math.round(requiredRate * floorFraction)));

  const remainingToday = Math.max(0, floor - loggedToday);
  const floorCleared = remainingToday === 0;

  /* Flat run-rate for the month so far, to say "two ahead of pace"
   * rather than making them work it out. */
  const expectedByNow = (monthlyTarget / daysInMonth) * dayOfMonth;
  const aheadBy = Math.round(monthDone - expectedByNow);

  const earnsRestDay = loggedToday >= Math.ceil(flatRateForCap * restDayMultiple);

  const ladder = [...witnesses].sort((a, b) => a.triggerDay - b.triggerDay);
  const notified = ladder.filter((w) => consecutiveMisses >= w.triggerDay).map((w) => w.name);
  const upcoming = ladder.find((w) => w.triggerDay > consecutiveMisses);

  return {
    state: stateFor(consecutiveMisses),
    monthDone, monthlyTarget, dayOfMonth, daysInMonth, daysLeft,
    requiredRate: Math.round(requiredRate * 10) / 10,
    paceDelta: Math.round(paceDelta * 10) / 10,
    floor, loggedToday, remainingToday, floorCleared,
    aheadBy,
    consecutiveMisses, restDaysBanked, earnsRestDay,
    nextWitness: upcoming
      ? { name: upcoming.name, triggerDay: upcoming.triggerDay, missesAway: upcoming.triggerDay - consecutiveMisses }
      : null,
    notified,
    targetMet,
  };
}

/* ---------------- the voice ---------------- */

/** Fallback copy, used when the LLM is unavailable or the tone dial is
 *  turned down. Deliberately built from the user's own numbers: an
 *  insult is dismissible, your own figures read back to you are not. */
export function fallbackMessage(e: EngineOutput): string {
  const n = (x: number) => x.toFixed(1).replace(/\.0$/, "");

  if (e.targetMet) {
    return `${e.monthDone} of ${e.monthlyTarget}. Target met with ${e.daysLeft} days spare. Nothing fires for the rest of the month.`;
  }

  if (e.floorCleared && e.consecutiveMisses === 0) {
    const pace = e.aheadBy > 0 ? `${e.aheadBy} ahead of pace` : e.aheadBy < 0 ? `${Math.abs(e.aheadBy)} behind pace` : "exactly on pace";
    return `Floor cleared. ${e.monthDone} of ${e.monthlyTarget}, ${pace}. That is all this screen has to say to you today.`;
  }

  switch (e.state) {
    case "clear":
      return `${e.remainingToday} to go today. ${e.monthDone} of ${e.monthlyTarget}. Nobody has been told anything.`;

    case "drift":
      return `${e.consecutiveMisses} days. Zero applications. The required rate moved to ${n(e.requiredRate)} a day while you did nothing. Nobody has been told yet.`;

    case "breach": {
      const w = e.nextWitness;
      return w
        ? `${e.consecutiveMisses} days. The rate is ${n(e.requiredRate)} and climbing while you read this. ${w.missesAway <= 1 ? `Tomorrow at 09:00 ${w.name} gets an email saying exactly this.` : `${w.name} is ${w.missesAway} days away.`} ${e.floor} applications stops it.`
        : `${e.consecutiveMisses} days. The rate is ${n(e.requiredRate)} and climbing while you read this.`;
    }

    case "terminal": {
      const told = e.notified.length
        ? `${e.notified.join(" and ")} ${e.notified.length > 1 ? "have" : "has"} been told.`
        : "";
      const next = e.nextWitness ? ` ${e.nextWitness.name} finds out at 09:00 tomorrow.` : "";
      return `${e.consecutiveMisses} days. ${e.monthDone} applications this month, none this week. ${told}${next}`;
    }
  }
}

/** One-line status for the equipment bar. */
export function stateLabel(s: WardenState): string {
  return { clear: "CLEAR", drift: "DRIFT", breach: "BREACH", terminal: "TERMINAL" }[s];
}
