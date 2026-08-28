import Link from "next/link";
import { Bar } from "@/components/Bar";
import { getPipeline, type PipelineFilter, type PipelineRow } from "@/lib/data";

export const dynamic = "force-dynamic";

const FILTERS: Array<{ key: PipelineFilter; label: string }> = [
  { key: "all", label: "All" },
  { key: "need", label: "Needs you" },
  { key: "live", label: "Live" },
  { key: "dead", label: "Dead" },
];

const STATUS_LABEL: Record<string, string> = {
  applied: "No reply",
  in_review: "In review",
  assessment: "Assessment",
  interview: "Interview",
  offer: "Offer",
  rejected: "Rejected",
  ghosted: "Ghosted",
  withdrawn: "Withdrawn",
};

export default async function Pipeline({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const { filter: raw } = await searchParams;
  const filter = (FILTERS.find((f) => f.key === raw)?.key ?? "all") as PipelineFilter;
  const m = await getPipeline(filter);

  return (
    <div className="app" data-state="clear">
      <Bar current="pipeline" />

      <section className="pipeline">
        <div className="funnel">
          <Cell n={m.funnel.applied} label="Applied"
                sub={m.funnel.since ? `since ${fmtDate(m.funnel.since)}` : "no data yet"} />
          <Cell n={m.funnel.replied} label="Replied" sub={`${m.funnel.repliedPct}%`} />
          <Cell n={m.funnel.rejected} label="Rejected" sub={`${m.funnel.rejectedPct}%`} />
          <Cell n={m.funnel.ghosted} label="Ghosted" sub={`${m.ghostDays} days silent`} bad />
          <Cell n={m.funnel.live} label="Still live" sub={`${m.counts.need} need you`} />
          <Cell n={m.funnel.interviews} label="Interviews" sub={`${m.funnel.interviewPct}% of applied`} />
        </div>

        {m.attention.length > 0 && (
          <div className="attention">
            <div className="att-head">Needs you — {m.attention.length}</div>
            {m.attention.map((a) => (
              <div className="att-row" key={a.id}>
                <div className="att-what">
                  {a.nextActionLabel?.startsWith("Interview") ? "Interview" : "Assessment"} — {a.company}
                  <span>{a.role}{a.location ? ` · ${a.location}` : ""}</span>
                </div>
                <div className="att-when">{whenLabel(a)}</div>
              </div>
            ))}
          </div>
        )}

        <div className="filters">
          <span>Filter</span>
          {FILTERS.map((f) => (
            <Link
              key={f.key}
              href={f.key === "all" ? "/pipeline" : `/pipeline?filter=${f.key}`}
              aria-current={filter === f.key ? "true" : undefined}
            >
              {f.label} {m.counts[f.key]}
            </Link>
          ))}
        </div>

        {m.rows.length === 0 ? (
          <div className="empty">
            Nothing here yet. Run <b>pnpm ingest</b> to pull the fixture inbox in,
            or log one by hand from Today.
          </div>
        ) : (
          <div className="scroll-x">
            <table>
              <thead>
                <tr>
                  <th>Company</th><th>Location</th><th>Salary</th><th>Via</th>
                  <th>Applied</th><th>Status</th><th>Silence</th><th>Posting</th>
                </tr>
              </thead>
              <tbody>
                {m.rows.map((r) => (
                  <tr key={r.id} className={r.group === "dead" ? "dead-row" : undefined}>
                    <td>
                      <div className="co">{r.company}</div>
                      <div className="ro">{r.role}</div>
                    </td>
                    <td data-label="Location"><span className="loc">{r.location ?? "—"}</span></td>
                    <td data-label="Salary">
                      {r.salaryRaw
                        ? <span className="pay">{r.salaryRaw}</span>
                        : <span className="pay none">Not stated</span>}
                    </td>
                    <td data-label="Via"><span className="via">{r.platform}</span></td>
                    <td data-label="Applied"><span className="num">{fmtDate(r.appliedAt)}</span></td>
                    <td data-label="Status">
                      <span className={`pill ${r.status}`}>
                        {r.status === "interview" && r.nextActionAt
                          ? `Interview ${fmtDate(r.nextActionAt)}`
                          : r.status === "assessment" && r.nextActionAt
                            ? whenLabel(r)
                            : STATUS_LABEL[r.status] ?? r.status}
                      </span>
                    </td>
                    <td data-label="Silence"><Decay days={r.silentDays} ghostAt={m.ghostDays} /></td>
                    <td data-label="Posting">
                      {r.url
                        ? <a className="open" href={r.url} target="_blank" rel="noopener">Open</a>
                        : <span className="open" style={{ borderColor: "transparent" }}>—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="foot">
          Silence bar fills over <b>{m.ghostDays} days</b>. At {m.ghostDays} an application is
          marked <b>ghosted</b> automatically and drops out of Live — no reply is a reply.
        </div>
      </section>
    </div>
  );
}

function Cell({ n, label, sub, bad }: { n: number; label: string; sub: string; bad?: boolean }) {
  return (
    <div className="fcell">
      <div className={`fnum${bad ? " bad" : ""}`}>{n}</div>
      <div className="flabel">{label}</div>
      <div className="fsub">{sub}</div>
    </div>
  );
}

function Decay({ days, ghostAt }: { days: number; ghostAt: number }) {
  const pct = Math.min(100, Math.round((days / ghostAt) * 100));
  const cls = days >= ghostAt ? "dead" : days >= ghostAt * 0.75 ? "warn" : "";
  return (
    <div className="decay">
      <div className="decay-track">
        <div className={`decay-fill ${cls}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="decay-days">{days}d</div>
    </div>
  );
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}

function whenLabel(r: PipelineRow): string {
  if (!r.nextActionAt) return STATUS_LABEL[r.status] ?? r.status;
  const days = Math.ceil((r.nextActionAt.getTime() - Date.now()) / 864e5);
  if (r.status === "assessment") {
    if (days < 0) return "Expired";
    if (days === 0) return "Closes today";
    return `Closes in ${days}d`;
  }
  return `${r.nextActionAt.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })} · ${r.nextActionAt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
}
