import { Bar } from "@/components/Bar";
import { LogApplication } from "@/components/LogApplication";
import { getToday } from "@/lib/data";

/* Reads the database and depends on the wall clock, so it can never be
 * statically rendered. */
export const dynamic = "force-dynamic";

const n1 = (x: number) => x.toFixed(1).replace(/\.0$/, "");

export default async function Today() {
  const m = await getToday();
  const e = m.engine;

  /* The hero number changes identity with state. On pace it shows
   * progress; behind, the same slot shows how long it has been. */
  const behind = e.state !== "clear";
  const heroNumber = behind ? e.consecutiveMisses : e.remainingToday;
  const heroLabel = behind ? "Days since you last applied" : "Applications still required today";

  const heroSub = behind
    ? [
        `Required rate is ${n1(e.requiredRate)} a day and climbing.`,
        e.nextWitness
          ? `${e.nextWitness.name} is ${e.nextWitness.missesAway} ${e.nextWitness.missesAway === 1 ? "day" : "days"} away.`
          : "Everyone has been told.",
        `${e.floor} ${e.floor === 1 ? "application" : "applications"} stops it.`,
      ].join("\n")
    : e.floorCleared
      ? `Floor cleared. Nothing fires today.\n${e.daysLeft} days left this cycle.`
      : `${e.remainingToday} of ${e.floor} still to go.\nThe ladder is armed until the floor is clear.`;

  const noticeKind = { clear: "System note", drift: "Notice 01", breach: "Notice 03 — final warning", terminal: "Notice 06 — non-compliance" }[e.state];
  const noticeStamp = e.nextWitness
    ? `${e.nextWitness.name} at ${e.nextWitness.triggerDay} missed days`
    : e.notified.length
      ? `${e.notified.join(", ")} notified`
      : "No escalation active";

  const pacePct = Math.min(100, Math.round((e.dayOfMonth / e.daysInMonth) * 100));
  const donePct = Math.min(100, Math.round((e.monthDone / e.monthlyTarget) * 100));

  return (
    <div className="app" data-state={e.state}>
      <Bar current="today" chip={m.chip} meta={m.meta} />

      <main className="today">
        <div className="ledger">
          <div className="meter">
            <div className="meter-label">
              <span>{new Date().toLocaleDateString("en-GB", { month: "long" })}</span>
              <span><b>{e.monthDone}</b> / {e.monthlyTarget}</span>
            </div>
            <div className="track">
              <div className="fill" style={{ width: `${donePct}%` }} />
              <div className="pace" style={{ left: `${pacePct}%` }} title="Flat run-rate to target" />
            </div>
          </div>
          <dl>
            <Row label="Required rate" value={`${n1(e.requiredRate)} / day`} />
            <Row label="Floor today" value={e.floor} />
            <Row label="Logged today" value={e.loggedToday} />
            <Row label="Days missed" value={e.consecutiveMisses} warn={e.consecutiveMisses > 0} />
            <Row label="Rest days banked" value={e.restDaysBanked} />
            <Row label="Awaiting reply" value={m.awaitingReply} />
            <Row label="Needs you" value={m.needsYouCount} warn={m.needsYouCount > 0} />
            <Row label="Interviews booked" value={m.interviewsBooked} />
          </dl>
        </div>

        <div className="field">
          <div className="eyebrow">
            {behind
              ? `Day ${e.consecutiveMisses} — no applications logged`
              : `Status — ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long" })}`}
          </div>

          <div className="hero">
            <p className="numeral">{heroNumber}</p>
            <div className="numeral-side">
              <p className="numeral-label">{heroLabel}</p>
              <p className="numeral-sub">{heroSub}</p>
            </div>
          </div>

          <div className="notice">
            <div className="notice-head">
              <span>{noticeKind}</span>
              <span>{noticeStamp}</span>
            </div>
            <p className="message">{m.message}</p>
          </div>

          <LogApplication />

          {m.needsYou ? (
            <div className="queue">
              <div>
                <div className="queue-label">Next thing that actually needs you</div>
                <p className="queue-role">{m.needsYou.role}</p>
                <p className="queue-co">
                  {m.needsYou.company} · {m.needsYou.label} ·{" "}
                  {m.needsYou.when.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}
                  {" "}
                  {m.needsYou.when.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
                </p>
              </div>
              <div className="queue-tag">
                {daysUntil(m.needsYou.when)}
              </div>
            </div>
          ) : (
            <div className="queue">
              <div>
                <div className="queue-label">Next thing that actually needs you</div>
                <p className="queue-role">Nothing scheduled</p>
                <p className="queue-co">No assessments open and no interviews booked.</p>
              </div>
              <div className="queue-tag">Clear</div>
            </div>
          )}
        </div>
      </main>

      <div className="track-wrap">
        <div className="track-head">
          <span>Escalation ladder</span>
          <span>
            {e.notified.length
              ? `${e.notified.join(" and ")} notified`
              : "Resets only on action — never on time"}
          </span>
        </div>
        <div className="scroll-x">
          <div className="rungs">
            {m.ladder.map((r) => (
              <div key={`${r.day}-${r.label}`} className={`rung ${r.state === "future" ? "" : r.state}`}>
                <div className="d">Day {r.day}</div>
                <div className="w">{r.label}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, warn }: { label: string; value: string | number; warn?: boolean }) {
  return (
    <div className="row">
      <dt>{label}</dt>
      <dd className={warn ? "warn" : undefined}>{value}</dd>
    </div>
  );
}

function daysUntil(d: Date): string {
  const days = Math.ceil((d.getTime() - Date.now()) / 864e5);
  if (days < 0) return "Overdue";
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  return `In ${days} days`;
}
