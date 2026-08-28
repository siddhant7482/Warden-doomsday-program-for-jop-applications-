import type { EngineOutput } from "./engine";
import type { Outgoing } from "./mailer";

/* ============================================================
   What the witnesses actually receive.

   Two rules, both from how this fails rather than how it works:

   1. Zero burden. The message states a fact; it never asks them to
      chase, reply, or feel responsible. A nudge system that costs its
      witnesses effort loses them inside a month, and then the ladder is
      a bluff.

   2. The heartbeat is the real mechanism. Anyone can switch off a
      cron job at midnight. A weekly "still running" makes the absence
      of mail informative — you cannot quietly disable something whose
      silence gets noticed.
   ============================================================ */

const SIGNOFF = "\n— Warden\nAutomated. Nothing is needed from you.";

function firstContactNote(user: string): string {
  return (
    `You are getting this because ${user} asked Warden to tell you when ` +
    `he stops applying for jobs. He set the thresholds himself.\n\n`
  );
}

export function witnessEmail(args: {
  witness: string;
  user: string;
  engine: EngineOutput;
  firstContact: boolean;
  nextWitnessIn: number | null;
}): Outgoing {
  const { witness, user, engine: e, firstContact, nextWitnessIn } = args;
  const rate = e.requiredRate.toFixed(1).replace(/\.0$/, "");

  /* Built as paragraphs rather than lines: filtering blank strings out
   * of a line array also removes every paragraph break. */
  const paragraphs = [
    `${witness},`,
    firstContact ? firstContactNote(user).trim() : null,
    [
      `As of this morning:`,
      ``,
      `  Days since he last applied      ${e.consecutiveMisses}`,
      `  Applications this month         ${e.monthDone} of ${e.monthlyTarget}`,
      `  Rate needed to still hit it     ${rate} a day`,
      `  Today's minimum                 ${e.floor}`,
    ].join("\n"),
    nextWitnessIn !== null
      ? `If nothing changes, one more person hears about this in ${nextWitnessIn} ${nextWitnessIn === 1 ? "day" : "days"}.`
      : `Everyone on his list has now been told.`,
    `You do not need to reply or chase him. That you received this is the\nentire mechanism.`,
  ].filter((p): p is string => Boolean(p));

  const body = paragraphs.join("\n\n") + "\n" + SIGNOFF;

  return {
    to: "",
    subject: `${user} — ${e.consecutiveMisses} days, no job applications`,
    text: body,
  };
}

export function heartbeatEmail(args: {
  witness: string;
  user: string;
  weekCount: number;
  engine: EngineOutput;
}): Outgoing {
  const { witness, user, weekCount, engine: e } = args;

  const text = [
    `${witness},`,
    "",
    `Still running. ${user} logged ${weekCount} ${weekCount === 1 ? "application" : "applications"} this week, ` +
      `${e.monthDone} of ${e.monthlyTarget} this month.`,
    "",
    e.consecutiveMisses === 0
      ? `Nothing is escalating.`
      : `He is ${e.consecutiveMisses} ${e.consecutiveMisses === 1 ? "day" : "days"} without applying.`,
    "",
    `These arrive weekly. If they stop, the system was switched off.`,
    SIGNOFF,
  ].join("\n");

  return { to: "", subject: `Warden — weekly check-in`, text };
}
