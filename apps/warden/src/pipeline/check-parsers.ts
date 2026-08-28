/* Runs every fixture through the parsers and prints what came out.
 * Not a unit test — a legibility harness. The point is to eyeball
 * which emails resolve cleanly, which get handed to the LLM, and
 * whether anything is confidently wrong (the only unacceptable case). */

import { FIXTURES } from "./fixtures";
import { parseEmail, TRUST_THRESHOLD, dedupeKey } from "./parse";

const pad = (s: string, n: number) =>
  (s.length > n ? s.slice(0, n - 1) + "…" : s).padEnd(n);

let trusted = 0;
let toLLM = 0;
const counts: Record<string, number> = {};

console.log(
  "\n" +
    pad("ID", 10) + pad("KIND", 20) + pad("CONF", 7) +
    pad("PLATFORM", 14) + pad("COMPANY", 20) + pad("ROLE", 30) + "ACTION",
);
console.log("-".repeat(115));

for (const email of FIXTURES) {
  const r = parseEmail(email);
  counts[r.kind] = (counts[r.kind] || 0) + 1;

  const ok = r.confidence >= TRUST_THRESHOLD;
  ok ? trusted++ : toLLM++;

  const action = r.actionAt
    ? `${r.actionLabel} ${r.actionAt.toISOString().slice(0, 16).replace("T", " ")}`
    : "";

  console.log(
    pad(email.gmailId, 10) +
      pad((ok ? "  " : "→ ") + r.kind, 20) +
      pad(r.confidence.toFixed(2), 7) +
      pad(r.platform, 14) +
      pad(r.company ?? "—", 20) +
      pad(r.role ?? "—", 30) +
      action,
  );
}

console.log("-".repeat(115));
console.log(`\n${trusted} parsed deterministically, ${toLLM} handed to the LLM  ` +
            `(${Math.round((trusted / FIXTURES.length) * 100)}% covered by patterns)\n`);
console.log("by kind:", counts, "\n");

/* Applications the pipeline would actually create, and the dedupe keys
 * that decide whether two emails are the same application. */
console.log("dedupe keys from application-bearing mail:");
const seen = new Map<string, string[]>();
for (const email of FIXTURES) {
  const r = parseEmail(email);
  const bearing = ["confirmation", "progress", "assessment", "interview", "rejection", "offer"];
  if (!bearing.includes(r.kind) || !r.company || !r.role) continue;
  const key = dedupeKey(r.company, r.role);
  seen.set(key, [...(seen.get(key) ?? []), email.gmailId]);
}
for (const [key, ids] of seen) {
  const flag = ids.length > 1 ? "  <- grouped" : "";
  console.log(`  ${pad(key, 48)} ${ids.join(", ")}${flag}`);
}
console.log(`\n${seen.size} distinct applications from ${FIXTURES.length} emails\n`);
