/* Walks the engine through a month of behaviour so the numbers can be
 * eyeballed. The thing to watch is the required rate climbing on its
 * own while nothing is logged — that climb is the entire mechanism. */

import { compute, fallbackMessage, type EngineInput } from "./engine";

const WITNESSES = [
  { name: "Aakash", triggerDay: 4 },
  { name: "Rhea", triggerDay: 6 },
  { name: "Dev", triggerDay: 9 },
];

const base = (over: Partial<EngineInput>): EngineInput => ({
  now: new Date(2026, 8, 8), // 8 September, 30-day month
  monthlyTarget: 100,
  floorFraction: 1.0,
  restDayMultiple: 2.5,
  monthDone: 29,
  loggedToday: 0,
  consecutiveMisses: 0,
  restDaysBanked: 0,
  witnesses: WITNESSES,
  ...over,
});

const pad = (s: string, n: number) => s.padEnd(n);

console.log("\nA month of slacking — same 29 applications, more days burned\n");
console.log(pad("DAY", 6) + pad("MISSES", 8) + pad("STATE", 10) + pad("RATE", 8) + pad("FLOOR", 7) + "NEXT WITNESS");
console.log("-".repeat(62));

for (const [day, misses] of [[8, 0], [10, 2], [12, 4], [14, 6], [17, 9], [22, 14]] as const) {
  const e = compute(base({ now: new Date(2026, 8, day), consecutiveMisses: misses }));
  console.log(
    pad(String(day), 6) + pad(String(misses), 8) + pad(e.state, 10) +
    pad(e.requiredRate.toFixed(1), 8) + pad(String(e.floor), 7) +
    (e.nextWitness ? `${e.nextWitness.name} in ${e.nextWitness.missesAway}` : "all told"),
  );
}

console.log("\n\nThe voice at each rung\n");
for (const misses of [0, 2, 4, 7]) {
  const e = compute(base({ consecutiveMisses: misses, loggedToday: misses === 0 ? 3 : 0 }));
  console.log(`[${e.state.toUpperCase()}] ${fallbackMessage(e)}\n`);
}

console.log("Clearing the floor, one at a time\n");
for (const logged of [0, 1, 2, 3, 8]) {
  const e = compute(base({ loggedToday: logged, monthDone: 29 + logged, consecutiveMisses: 0 }));
  console.log(
    pad(`logged ${logged}`, 12) +
    pad(`floor ${e.floor}`, 10) +
    pad(`${e.remainingToday} to go`, 12) +
    pad(e.floorCleared ? "CLEARED" : "armed", 10) +
    (e.earnsRestDay ? "+1 rest day banked" : ""),
  );
}

const met = compute(base({ monthDone: 100, loggedToday: 4 }));
console.log(`\ntarget met: floor=${met.floor}, "${fallbackMessage(met)}"\n`);
