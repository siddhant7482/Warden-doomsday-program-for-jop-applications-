import "@/env";

import { FIXTURES } from "@/pipeline/fixtures";
import { parseEmail, TRUST_THRESHOLD } from "@/pipeline/parse";
import { triageEmail } from "@/pipeline/llm";
import { compute, fallbackMessage, type EngineInput } from "./engine";
import { composeMessage } from "./voice";
import { hasKey, MODELS } from "./openrouter";

/* Exercises both OpenRouter call sites end to end:
 *   1. reading the emails the pattern parsers could not
 *   2. writing the daily message at each rung of the ladder
 *
 * Costs real money — a handful of small calls, well under a penny. */

const line = (n = 74) => console.log("-".repeat(n));

async function main() {
  if (!hasKey()) {
    console.log(`
No OPENROUTER_API_KEY set.

  1. Get a key at https://openrouter.ai/keys
  2. Put it in apps/warden/.env.local:
       OPENROUTER_API_KEY="sk-or-v1-..."
  3. Re-run: pnpm check:llm

Warden runs fine without it — pattern parsing still covers 93% of mail
and the daily message falls back to deterministic copy. This only turns
on the messy tail and the generated voice.
`);
    process.exit(1);
  }

  console.log(`\ntriage model : ${MODELS.triage()}`);
  console.log(`voice model  : ${MODELS.reason()}\n`);

  /* ---- 1. the messy tail ---- */
  const hard = FIXTURES.filter((f) => parseEmail(f).confidence < TRUST_THRESHOLD);
  console.log(`READING THE MESSY TAIL — ${hard.length} of ${FIXTURES.length} emails patterns could not resolve\n`);

  for (const email of hard) {
    const before = parseEmail(email);
    const { result, triage, error } = await triageEmail(email, before.platform);
    console.log(`  ${email.gmailId}  ${email.subject}`);
    console.log(`    from     ${email.from}`);
    console.log(`    pattern  ${before.kind} (${before.confidence.toFixed(2)})`);
    if (error) {
      console.log(`    model    FAILED — ${error}`);
    } else if (result && triage) {
      console.log(`    model    ${result.kind} (${result.confidence.toFixed(2)})  ${result.company ?? "—"} / ${result.role ?? "—"}`);
      console.log(`    why      ${triage.why}`);
    }
    console.log();
  }

  /* ---- 2. the voice ---- */
  line();
  console.log("\nTHE VOICE — same person, four rungs\n");

  const base = (over: Partial<EngineInput>): EngineInput => ({
    now: new Date(),
    monthlyTarget: 100,
    floorFraction: 1.0,
    restDayMultiple: 2.5,
    monthDone: 29,
    loggedToday: 0,
    consecutiveMisses: 0,
    restDaysBanked: 0,
    witnesses: [
      { name: "Aakash", triggerDay: 4 },
      { name: "Rhea", triggerDay: 6 },
      { name: "Dev", triggerDay: 9 },
    ],
    ...over,
  });

  const seen: string[] = [];
  for (const [misses, logged] of [[0, 3], [2, 0], [4, 0], [7, 0]] as const) {
    const engine = compute(base({ consecutiveMisses: misses, loggedToday: logged, monthDone: 29 + logged }));
    const { text, generated } = await composeMessage({ engine, recent: seen, tone: 1.0 });
    seen.push(text);

    console.log(`[${engine.state.toUpperCase()}]  ${misses} missed days${generated ? "" : "   (FELL BACK to deterministic copy)"}`);
    console.log(text.split("\n").map((l) => `   ${l}`).join("\n"));
    console.log();
  }

  /* ---- 3. the tone dial ---- */
  line();
  console.log("\nTHE TONE DIAL — same state, dialled down\n");
  const bad = compute(base({ consecutiveMisses: 7 }));
  for (const tone of [1.0, 0.6, 0.2]) {
    const { text } = await composeMessage({ engine: bad, recent: [], tone });
    console.log(`  tone ${tone.toFixed(1)}  ${text.replace(/\n/g, " ")}\n`);
  }

  console.log("deterministic fallback for comparison:");
  console.log(`  ${fallbackMessage(bad)}\n`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
