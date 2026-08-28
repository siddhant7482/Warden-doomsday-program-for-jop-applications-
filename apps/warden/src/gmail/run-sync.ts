import "@/env";

import { db } from "@/db";
import { accounts } from "@/db/schema";
import { syncAll } from "./sync";
import { isConfigured } from "./oauth";
import { hasEncryptionKey } from "@/lib/crypto";

/* CLI:
 *   pnpm sync            pull, parse, write
 *   pnpm sync --dry      pull and parse, write nothing
 *   pnpm sync --llm      send the messy tail to OpenRouter too
 *
 * Nothing here runs on a schedule. Arming that is a deployment step, by
 * design — the sync is only started once Warden is on the ThinkCentre.
 */

async function main() {
  const dryRun = process.argv.includes("--dry");
  const useLLM = process.argv.includes("--llm");

  if (!isConfigured()) {
    console.log(`
Google OAuth is not configured yet.

  1. console.cloud.google.com -> new project
  2. APIs & Services -> Library -> enable "Gmail API"
  3. OAuth consent screen -> External -> add yourself as a test user
  4. Credentials -> Create OAuth client ID -> Web application
     Authorised redirect URI must match GOOGLE_REDIRECT_URI exactly.
  5. Put the client id/secret in .env.local, then visit:
       /api/auth/google
`);
    process.exit(1);
  }

  if (!hasEncryptionKey()) {
    console.log(`
TOKEN_ENCRYPTION_KEY is not set. Generate one:

  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

Put it in .env.local. It encrypts the Gmail refresh token at rest, so
the nightly pg_dump that goes to Backblaze does not carry a plaintext
key to the mailbox. Losing this key means re-authorising, nothing worse.
`);
    process.exit(1);
  }

  const active = await db.select().from(accounts);
  const authorised = active.filter((a) => a.refreshToken);
  if (authorised.length === 0) {
    console.log(`
No mailbox has been authorised yet.

  Start Warden, then open:  http://localhost:3000/api/auth/google

Accounts on record: ${active.length ? active.map((a) => a.email).join(", ") : "none"}
`);
    process.exit(1);
  }

  console.log(`\nsyncing ${authorised.length} mailbox(es)${dryRun ? "  [DRY RUN — nothing will be written]" : ""}`);

  const { reports, ghosted } = await syncAll({
    dryRun,
    useLLM,
    onProgress: (m) => console.log(m),
  });

  console.log("\n" + "-".repeat(64));
  for (const r of reports) {
    console.log(`\n${r.account}`);
    if (r.error) {
      console.log(`  ERROR  ${r.error}`);
      continue;
    }
    console.log(`  matched            ${r.matched}`);
    console.log(`  fetched            ${r.fetched}`);
    if (r.ingest) {
      const i = r.ingest;
      console.log(`  new to us          ${i.stored}`);
      console.log(`  already seen       ${i.skipped}`);
      console.log(`  applications made  ${i.applicationsCreated}`);
      console.log(`  re-applications    ${i.duplicatesFolded}  (folded, not double-counted)`);
      console.log(`  unresolved         ${i.unresolved}  (need review)`);
      console.log(`  handed to LLM      ${i.needsLLM}${useLLM ? ` (${i.llmResolved} resolved)` : " (skipped — pass --llm)"}`);
      console.log(`  by kind            ${JSON.stringify(i.byKind)}`);
      for (const e of i.llmErrors) console.log(`    ! ${e}`);
    } else if (dryRun) {
      console.log(`  (dry run — parsed but not written)`);
    }
  }

  if (!dryRun) console.log(`\nghost sweep: ${ghosted} application(s) past 60 days of silence`);
  console.log();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
