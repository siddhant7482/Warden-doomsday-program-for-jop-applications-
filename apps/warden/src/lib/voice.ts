import { chatText, MODELS, hasKey } from "./openrouter";
import { fallbackMessage, type EngineOutput } from "./engine";

/* ============================================================
   The voice.

   Generated fresh every day from real numbers, which is the point:
   nothing has ever worked on this user because every system said the
   same thing in the same tone until it became wallpaper. A message
   built from figures that changed overnight cannot habituate.

   The craft rules below are load-bearing, not decoration:

     - Specific beats loud. An insult is dismissible; "two applications
       in nine days" is not, because it is just their own record read
       back to them.
     - Profanity works by violating expectation. Swear in every message
       and there is no violation left — it becomes texture and stops
       landing inside a week. So: none at the calm end, at most one at
       the deep end, placed as the last beat of a short line.
     - Escalate register, not volume. Clinical, then contemptuous, then
       vicious. Different voices, not louder ones.
   ============================================================ */

const REGISTER: Record<string, string> = {
  clear: `FLAT. Almost bored. State the facts and stop.
Withhold approval — do not congratulate, do not encourage, do not use an
exclamation mark. Clearing the floor is the baseline, not an achievement.
No profanity. Two lines maximum.`,

  drift: `COLD and pointed. Name the number that moved and make clear they moved
it. Note that nobody has been told yet — the fact it is still private is the
lever. No profanity, no insults; the arithmetic is the accusation.`,

  breach: `CONTEMPTUOUS. Formal, clipped, like a notice rather than a person.
Name the witness who is about to be emailed and how little time is left.
State plainly what stops it. At most ONE swear word, and only if it lands as
the final beat of a line. Never open with it.`,

  terminal: `VICIOUS, but through facts, not abuse. Name who has already been
told and who finds out next. Contrast what they have said about themselves
with what the record shows. At most ONE swear word, placed as the last beat of
a short line. Do not pile on — one clean cut is worse than a rant.`,
};

const SYSTEM = `You write one short message shown on a screen a person opens
every morning. It exists to get them to apply for jobs. They have ADHD, nothing
has ever worked on them, and they explicitly asked for this to be harsh.

You are not a coach. Never encourage, never advise, never suggest a strategy,
never offer sympathy, never ask a question. You do not greet them and you do
not sign off.

HOW TO MAKE IT LAND:
- Use their real numbers, exactly as given. Numbers are the weapon; an insult
  can be argued with, their own record cannot.
- Say the thing that is true and uncomfortable, not the thing that is loud.
- Short declarative sentences. Fragments are fine.
- Second person. Present tense.
- 2 to 4 lines. Under 45 words total. Every word must earn its place.
- Never reuse a construction from the recent messages you are shown.

THE WITNESSES are real people — the user's actual friends, who receive
real emails when the ladder fires. Refer to them by the name you are
given. Their pronouns are unknown to you, so use "they/them" if you need
a pronoun at all, and never infer gender from a name. Preferably just
reuse the name.

NEVER:
- No greeting, no name for the user, no sign-off.
- No advice, no encouragement, no "you've got this", no motivational framing.
- No emoji, no markdown, no quotation marks around the whole message.
- Do not invent facts, deadlines, names or numbers you were not given.
- Do not invent details about their life: what they did instead, what they
  were watching or scrolling, how they feel, what they told themselves. You
  know the numbers below and nothing else. Inventing colour makes it fiction,
  and fiction is arguable — the numbers are not. Cut, do not embellish.
- Do not threaten anything beyond the escalation you are told about.

Return only the message text.`;

export interface VoiceContext {
  engine: EngineOutput;
  /** Recent messages, so the same construction never lands twice. */
  recent: string[];
  /** 0 = clinical and restrained, 1 = as written. Turning it down beats
   *  abandoning the whole system on a bad day. */
  tone: number;
}

function buildUser({ engine: e, recent, tone }: VoiceContext): string {
  const facts = [
    `State: ${e.state}`,
    `Applications this month: ${e.monthDone} of ${e.monthlyTarget}`,
    `Day ${e.dayOfMonth} of ${e.daysInMonth}, ${e.daysLeft} days left in the cycle`,
    `Required rate now: ${e.requiredRate} per day`,
    e.paceDelta > 0 ? `The rate rose by ${e.paceDelta} because of days they skipped` : null,
    `Today's floor: ${e.floor}. Logged today: ${e.loggedToday}. Still needed: ${e.remainingToday}`,
    `Consecutive days missed: ${e.consecutiveMisses}`,
    e.aheadBy !== 0
      ? `They are ${Math.abs(e.aheadBy)} ${e.aheadBy > 0 ? "ahead of" : "behind"} a flat run-rate`
      : `They are exactly on pace`,
    e.notified.length
      ? `Already told: ${e.notified.join(", ")}`
      : `Nobody has been told yet`,
    e.nextWitness
      ? `Next to be emailed: ${e.nextWitness.name}, at ${e.nextWitness.triggerDay} missed days (${e.nextWitness.missesAway} away)`
      : `Every witness has already been told`,
    e.targetMet ? `The monthly target is MET. Do not push them further.` : null,
  ].filter(Boolean).join("\n");

  const toneNote =
    tone >= 0.85 ? "Tone dial: full. Write it as harshly as the register allows."
    : tone >= 0.5 ? "Tone dial: reduced. Keep the register but drop any profanity and soften the personal edge."
    : "Tone dial: low. Clinical and factual only. No profanity, no contempt — just the numbers, stated plainly.";

  return [
    "FACTS — use these and nothing else:",
    facts,
    "",
    `REGISTER for this state:`,
    REGISTER[e.state] ?? REGISTER.clear,
    "",
    toneNote,
    recent.length
      ? `\nRECENT MESSAGES — do not repeat these openings, structures or phrasings:\n${recent.map((r) => `- ${r}`).join("\n")}`
      : "",
  ].join("\n");
}

/** Generates the day's message. Falls back to deterministic copy on any
 *  failure — the enforcement engine cannot depend on a third party
 *  being reachable at 9am. */
export async function composeMessage(ctx: VoiceContext): Promise<{ text: string; generated: boolean }> {
  if (!hasKey() || ctx.tone <= 0) {
    return { text: fallbackMessage(ctx.engine), generated: false };
  }

  try {
    const text = await chatText({
      model: MODELS.reason(),
      system: SYSTEM,
      user: buildUser(ctx),
      maxTokens: 250,
      // High enough that thirty consecutive mornings do not rhyme.
      temperature: 0.95,
    });

    const cleaned = text.replace(/^["'`]+|["'`]+$/g, "").trim();
    // A model that ignores the length rule produces something that
    // reads like advice. Fall back rather than ship it.
    if (!cleaned || cleaned.split(/\s+/).length > 90) {
      return { text: fallbackMessage(ctx.engine), generated: false };
    }
    return { text: cleaned, generated: true };
  } catch {
    return { text: fallbackMessage(ctx.engine), generated: false };
  }
}
