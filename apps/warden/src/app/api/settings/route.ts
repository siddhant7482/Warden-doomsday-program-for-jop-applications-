import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { settings } from "@/db/schema";
import { computeState } from "@/lib/data";

export const dynamic = "force-dynamic";

/* Settings the deck can reach. Only the monthly target for now — it is
 * the one number worth changing without opening Warden, and a stepper
 * on the panel that did not actually move it would be exactly the kind
 * of ornament the deck is not allowed to carry. */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const raw = Number(body?.monthlyTarget);
    if (!Number.isFinite(raw)) {
      return NextResponse.json({ ok: false, message: "monthlyTarget must be a number" }, { status: 400 });
    }

    // Clamped rather than rejected: the deck sends steps of ten and
    // should never be able to put Warden into an impossible state.
    const monthlyTarget = Math.max(10, Math.min(1000, Math.round(raw)));

    await db.update(settings).set({ monthlyTarget, updatedAt: new Date() }).where(eq(settings.id, 1));

    const { engine } = await computeState();
    return NextResponse.json(
      {
        ok: true,
        monthlyTarget,
        message: `${monthlyTarget} a month · ${engine.requiredRate.toFixed(1)} a day`,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    return NextResponse.json({ ok: false, message: (e as Error).message }, { status: 500 });
  }
}

/** So the deck can show the current value without guessing. */
export async function GET() {
  const [s] = await db.select().from(settings).limit(1);
  return NextResponse.json(
    { monthlyTarget: s?.monthlyTarget ?? 100, tone: s?.tone ?? 1, ghostDays: s?.ghostDays ?? 60 },
    { headers: { "cache-control": "no-store" } },
  );
}
