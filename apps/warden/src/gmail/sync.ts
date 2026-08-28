import { eq } from "drizzle-orm";
import { db } from "@/db";
import { accounts } from "@/db/schema";
import { decryptSecret } from "@/lib/crypto";
import { refreshAccessToken } from "./oauth";
import { defaultQuery, getMessage, listMessageIds, toRawEmail, GmailError } from "./client";
import { ingest, sweepGhosts, type IngestReport } from "@/pipeline/ingest";
import type { RawEmail } from "@/pipeline/fixtures";

/* ============================================================
   Pulling mail.

   Deliberately dumb about state: every run asks Gmail for messages
   newer than a window and lets the unique (account, gmail_id) index
   throw away what we already have. That is more robust than the
   history API — which only retains about a week and breaks if a sync
   is ever missed — and re-running can never double-count.
   ============================================================ */

/** How far back to look. The first sync wants a wide window; later runs
 *  only need to cover the gap since the last one, plus slack. */
function windowDays(lastSyncedAt: Date | null, firstRunDays: number): number {
  if (!lastSyncedAt) return firstRunDays;
  const since = (Date.now() - lastSyncedAt.getTime()) / 864e5;
  return Math.min(firstRunDays, Math.max(2, Math.ceil(since) + 1));
}

/** Small concurrency: Gmail allows far more, but there is no reason to
 *  hammer it, and a burst on a 4-thread box costs more than it saves. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const i = cursor++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

export interface SyncReport {
  account: string;
  matched: number;
  fetched: number;
  ingest: IngestReport | null;
  error?: string;
}

export interface SyncOptions {
  /** Fetch and parse but write nothing. Use this the first time against
   *  a real mailbox — it shows what would be created before it is. */
  dryRun?: boolean;
  useLLM?: boolean;
  firstRunDays?: number;
  cap?: number;
  onProgress?: (msg: string) => void;
}

/** Syncs one account. Never throws — a dead account should not stop the
 *  other one, and the enforcement engine has to keep working on
 *  whatever data it already has. */
export async function syncAccount(
  accountId: number,
  opts: SyncOptions = {},
): Promise<SyncReport> {
  const { dryRun = false, useLLM = false, firstRunDays = 90, cap = 500, onProgress } = opts;
  const log = onProgress ?? (() => {});

  const [acct] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
  if (!acct) return { account: `#${accountId}`, matched: 0, fetched: 0, ingest: null, error: "no such account" };
  if (!acct.refreshToken) {
    return { account: acct.email, matched: 0, fetched: 0, ingest: null, error: "not authorised — visit /api/auth/google" };
  }

  try {
    const accessToken = await refreshAccessToken(decryptSecret(acct.refreshToken));

    const days = windowDays(acct.lastSyncedAt, firstRunDays);
    const query = defaultQuery(days);
    log(`  query: ${query.slice(0, 110)}${query.length > 110 ? "…" : ""}`);

    const ids = await listMessageIds(accessToken, query, cap);
    log(`  ${ids.length} message(s) matched in the last ${days} days`);
    if (ids.length === 0) {
      if (!dryRun) await db.update(accounts).set({ lastSyncedAt: new Date() }).where(eq(accounts.id, accountId));
      return { account: acct.email, matched: 0, fetched: 0, ingest: null };
    }

    const raws: RawEmail[] = await mapLimit(ids, 5, async ({ id }) => {
      const msg = await getMessage(accessToken, id);
      return toRawEmail(msg, acct.email);
    });
    log(`  fetched ${raws.length} bodies`);

    if (dryRun) {
      return { account: acct.email, matched: ids.length, fetched: raws.length, ingest: null };
    }

    const report = await ingest(raws, { useLLM });
    await db.update(accounts).set({ lastSyncedAt: new Date() }).where(eq(accounts.id, accountId));

    return { account: acct.email, matched: ids.length, fetched: raws.length, ingest: report };
  } catch (e) {
    const msg = e instanceof GmailError ? e.message : (e as Error).message;
    return { account: acct.email, matched: 0, fetched: 0, ingest: null, error: msg };
  }
}

export async function syncAll(opts: SyncOptions = {}): Promise<{ reports: SyncReport[]; ghosted: number }> {
  const active = await db.select().from(accounts).where(eq(accounts.active, true));
  const reports: SyncReport[] = [];

  for (const acct of active) {
    opts.onProgress?.(`\n${acct.email}`);
    reports.push(await syncAccount(acct.id, opts));
  }

  // Silence is only a verdict once the inbox has actually been checked.
  const ghosted = opts.dryRun ? 0 : await sweepGhosts(60);
  return { reports, ghosted };
}
