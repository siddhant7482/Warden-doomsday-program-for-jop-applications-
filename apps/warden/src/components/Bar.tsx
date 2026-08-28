import Link from "next/link";

/* The equipment bar. Present on both views; only the state chip and the
 * active nav item change. */
export function Bar({
  current,
  chip,
  meta,
}: {
  current: "today" | "pipeline";
  chip?: string;
  meta?: string;
}) {
  return (
    <div className="bar">
      <div className="id">WARDEN</div>
      <div className="parent">COMMANDHQ &middot; NODE 105</div>
      <div className="nav">
        <Link href="/" aria-current={current === "today" ? "page" : undefined}>Today</Link>
        <Link href="/pipeline" aria-current={current === "pipeline" ? "page" : undefined}>Pipeline</Link>
      </div>
      {meta ? <div className="meta"><span>{meta}</span></div> : null}
      {chip ? <div><span className="statechip">{chip}</span></div> : null}
    </div>
  );
}
