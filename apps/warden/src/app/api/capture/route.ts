import { NextResponse } from "next/server";
import type { CaptureResult } from "@/lib/status-contract";
import { db } from "@/db";
import { applications } from "@/db/schema";
import { dedupeKey } from "@/pipeline/parse";
import { computeState } from "@/lib/data";

export const dynamic = "force-dynamic";

/* The LOG button on the deck. Deliberately the same write the app's own
 * form performs, marked `manual` either way — the share of the count
 * that no email can vouch for stays visible. */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const company = String(body?.company ?? "Quick log").trim();
    const role = String(body?.role ?? "Unspecified").trim();

    const now = new Date();
    await db.insert(applications).values({
      company, role,
      platform: "other",
      status: "applied",
      appliedAt: now,
      lastContactAt: now,
      dedupeKey: dedupeKey(company, role),
      manual: true,
    });

    const { engine } = await computeState();
    const result: CaptureResult = {
      ok: true,
      message: `${engine.monthDone} of ${engine.monthlyTarget} · rate now ${engine.requiredRate.toFixed(1)}/day`,
    };
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ ok: false, message: (e as Error).message }, { status: 500 });
  }
}
