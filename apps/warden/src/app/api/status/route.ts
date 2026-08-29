import { NextResponse } from "next/server";
import type { AppStatus } from "@/lib/status-contract";
import { computeState, getPipeline } from "@/lib/data";

export const dynamic = "force-dynamic";

/* Warden's half of the CommandHQ status contract. The hub reads this
 * rather than Warden's database, which is what lets Warden change its
 * schema without breaking the front door. */
export async function GET() {
  try {
    const { engine } = await computeState();
    const pipe = await getPipeline("need");

    const level: AppStatus["level"] =
      engine.state === "clear" ? "ok" : engine.state === "drift" ? "warn" : "attention";

    const alerts: AppStatus["alerts"] = [];

    // The ladder is the loudest thing Warden has to say.
    if (engine.nextWitness && engine.consecutiveMisses > 0) {
      const w = engine.nextWitness;
      alerts.push({
        text:
          w.missesAway <= 1
            ? `${engine.consecutiveMisses} days without applying — ${w.name} is emailed at 09:00`
            : `${engine.consecutiveMisses} days without applying — ${w.name} in ${w.missesAway} days`,
        severity: w.missesAway <= 1 ? "urgent" : "soon",
        href: "/",
      });
    }

    // Assessments and interviews are the only things that need a human.
    for (const row of pipe.rows.slice(0, 4)) {
      if (!row.nextActionAt) continue;
      const days = Math.ceil((row.nextActionAt.getTime() - Date.now()) / 864e5);
      alerts.push({
        text:
          row.status === "assessment"
            ? `Assessment — ${row.company}, ${row.role}`
            : `Interview — ${row.company}, ${row.role}`,
        due: row.nextActionAt.toISOString(),
        severity: days <= 2 ? "urgent" : "soon",
        href: "/pipeline",
      });
    }

    const status: AppStatus = {
      app: "warden",
      level,
      headline: engine.floorCleared && engine.consecutiveMisses === 0
        ? `Floor cleared · ${engine.monthDone} of ${engine.monthlyTarget}`
        : `${engine.consecutiveMisses}d · ${engine.remainingToday} still required today`,
      metrics: [
        { label: "state", value: `${engine.state.toUpperCase()} · ${engine.consecutiveMisses}d` },
        { label: "month", value: `${engine.monthDone} / ${engine.monthlyTarget}` },
      ],
      alerts,
      at: new Date().toISOString(),
    };

    // Never cache: the panel is only useful if it is current.
    return NextResponse.json(status, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return NextResponse.json(
      { app: "warden", level: "down", headline: `Warden error: ${(e as Error).message}`, metrics: [], alerts: [], at: new Date().toISOString() },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}
