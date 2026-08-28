import "@/env";

import { db } from "@/db";
import { witnesses } from "@/db/schema";
import { tick, arm } from "./tick";
import { isConfigured, isPlaceholder, verifyConnection } from "@/lib/mailer";

/* CLI:
 *   pnpm tick              show what the ladder owes today. Sends nothing.
 *   pnpm tick --send       actually send (also requires settings.armed)
 *   pnpm tick --arm        turn the ladder on
 *   pnpm tick --disarm     turn it off
 *   pnpm tick --smtp       prove the SMTP credentials work, email nobody
 *
 * Dry by default, deliberately. The cost of not sending is a missed
 * nudge; the cost of sending wrongly is an email to someone's friend
 * that cannot be recalled.
 */

const line = (n = 68) => console.log("-".repeat(n));

async function main() {
  const argv = process.argv.slice(2);
  const send = argv.includes("--send");

  if (argv.includes("--smtp")) {
    if (!isConfigured()) {
      console.log("\nSMTP is not configured. Set SMTP_HOST, SMTP_USER and SMTP_PASS in .env.local.\n");
      process.exit(1);
    }
    try {
      await verifyConnection();
      console.log("\nSMTP credentials accepted. No mail was sent.\n");
      process.exit(0);
    } catch (e) {
      console.log(`\nSMTP failed: ${(e as Error).message}\n`);
      process.exit(1);
    }
  }

  if (argv.includes("--arm") || argv.includes("--disarm")) {
    const on = argv.includes("--arm");
    const r = await arm(on);
    if (!r.ok) {
      console.log(`\nCannot arm: ${r.reason}\n`);
      console.log("The ladder is only a real threat if it can actually fire.");
      console.log("Set the witnesses' real addresses first:\n");
      const people = await db.select().from(witnesses);
      for (const w of people) {
        console.log(`  ${w.name.padEnd(10)} ${w.email}${isPlaceholder(w.email) ? "   <- placeholder" : ""}`);
      }
      console.log();
      process.exit(1);
    }
    console.log(`\nLadder ${on ? "ARMED — witnesses will be emailed" : "disarmed — nothing will send"}.\n`);
    process.exit(0);
  }

  const r = await tick({ dryRun: !send });

  console.log(`\n${r.now.toDateString()}`);
  line();
  console.log(`  armed              ${r.armed ? "yes" : "no — nothing will send"}`);
  console.log(`  smtp configured    ${r.smtpConfigured ? "yes" : "no"}`);
  console.log(`  mode               ${r.dryRun ? "DRY RUN — nothing will be sent" : "SENDING"}`);
  console.log();
  console.log(`  days missed        ${r.consecutiveMisses}`);
  console.log(`  this month         ${r.monthDone} of ${r.monthlyTarget}`);
  console.log(`  floor / logged     ${r.floor} / ${r.loggedToday}`);

  if (r.planned.length === 0) {
    console.log(`\n  nothing due today\n`);
  } else {
    console.log(`\n  ${r.planned.length} notice(s) due:\n`);
    for (const p of r.planned) {
      console.log(`  ${"=".repeat(62)}`);
      console.log(`  ${p.kind.toUpperCase()} -> ${p.witness} <${p.to}>${p.blocked ? `   BLOCKED: ${p.blocked}` : ""}`);
      console.log(`  Subject: ${p.subject}`);
      console.log();
      console.log(p.body.split("\n").map((l) => `    ${l}`).join("\n"));
      console.log();
    }
  }

  for (const s of r.skipped) console.log(`  skipped: ${s}`);
  for (const s of r.sent) console.log(`  SENT: ${s}`);
  for (const e of r.errors) console.log(`  ERROR: ${e}`);

  if (r.dryRun && r.planned.some((p) => !p.blocked)) {
    console.log(`\n  To send for real:  pnpm tick --send   (needs --arm first)`);
  }
  console.log();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
