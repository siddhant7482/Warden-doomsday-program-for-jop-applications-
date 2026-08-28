import "@/env";

import { asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { accounts, applications, emails, settings, witnesses } from "@/db/schema";
import { FIXTURES } from "./fixtures";
import { ingest, sweepGhosts } from "./ingest";

/* CLI: seed what's missing, ingest the fixture inbox, sweep ghosts,
 * then print what the pipeline actually believes. Safe to re-run —
 * ingestion is idempotent on (account, gmailId). */

const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s).padEnd(n);

async function seed() {
  const have = await db.select().from(settings).limit(1);
  if (!have[0]) {
    await db.insert(settings).values({ id: 1 });
    console.log("seeded settings — target 100/month, ghost at 60 days");
  }

  const haveAccounts = await db.select().from(accounts);
  if (haveAccounts.length === 0) {
    await db.insert(accounts).values([
      { email: "siddh.primary@gmail.com", label: "Primary" },
      { email: "siddh.apps@gmail.com", label: "Applications" },
    ]);
    console.log("seeded 2 mail accounts");
  }

  const haveWitnesses = await db.select().from(witnesses);
  if (haveWitnesses.length === 0) {
    await db.insert(witnesses).values([
      { name: "Aakash", email: "aakash@example.com", triggerDay: 4 },
      { name: "Rhea", email: "rhea@example.com", triggerDay: 6 },
      { name: "Dev", email: "dev@example.com", triggerDay: 9 },
    ]);
    console.log("seeded 3 witnesses (placeholder addresses — replace before arming)");
  }
}

async function main() {
  await seed();

  const [cfg] = await db.select().from(settings).limit(1);

  console.log(`\ningesting ${FIXTURES.length} fixture emails…\n`);
  const useLLM = process.argv.includes("--llm");
  if (useLLM) console.log("  (--llm: sending the messy tail to OpenRouter)");
  const r = await ingest(FIXTURES, { useLLM });

  console.log(`  stored              ${r.stored}`);
  console.log(`  already seen        ${r.skipped}`);
  console.log(`  applications made   ${r.applicationsCreated}`);
  console.log(`  applications moved  ${r.applicationsTouched}`);
  console.log(`  re-applications     ${r.duplicatesFolded}  (folded, not double-counted)`);
  console.log(`  unresolved          ${r.unresolved}`);
  console.log(`  handed to LLM       ${r.needsLLM}${useLLM ? ` (${r.llmResolved} resolved)` : " (skipped — pass --llm)"}`);
  for (const e of r.llmErrors) console.log(`    ! ${e}`);
  console.log(`  by kind             ${JSON.stringify(r.byKind)}`);

  const ghosted = await sweepGhosts(cfg.ghostDays);
  console.log(`\nghost sweep: ${ghosted} application(s) past ${cfg.ghostDays} days of silence\n`);

  const rows = await db.select().from(applications).orderBy(asc(applications.appliedAt));
  const counts = await db
    .select({ status: applications.status, n: sql<number>`count(*)::int` })
    .from(applications)
    .groupBy(applications.status);

  console.log(pad("COMPANY", 18) + pad("ROLE", 26) + pad("VIA", 12) + pad("STATUS", 12) + pad("SILENT", 8) + "NEXT ACTION");
  console.log("-".repeat(100));
  for (const a of rows) {
    const silent = Math.floor((Date.now() - a.lastContactAt.getTime()) / 864e5);
    const next = a.nextActionAt
      ? `${a.nextActionLabel} ${a.nextActionAt.toISOString().slice(0, 10)}`
      : "";
    console.log(
      pad(a.company, 18) + pad(a.role, 26) + pad(a.platform, 12) +
      pad(a.status, 12) + pad(`${silent}d`, 8) + next,
    );
  }
  console.log("-".repeat(100));
  console.log("\nby status:", Object.fromEntries(counts.map((c) => [c.status, c.n])));

  const [{ n: unresolvedCount }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(emails)
    .where(eq(emails.unresolved, true));
  const [{ n: emailCount }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(emails);

  console.log(`\n${rows.length} applications from ${emailCount} emails, ${unresolvedCount} email(s) need review\n`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
