"use client";

import { useState, useTransition } from "react";
import { logApplication } from "@/app/actions";

/* One tap to open, two fields, done. The count has to stay auditable,
 * so a manual entry still has to say what it was — but the friction
 * stops there. */
export function LogApplication() {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <div className="actions">
        <button className="log" onClick={() => setOpen(true)}>Log application</button>
        <span className="linkish" style={{ border: 0, cursor: "default" }}>
          Confirmations from Gmail log themselves
        </span>
      </div>
    );
  }

  return (
    <form
      className="actions"
      action={(fd) =>
        start(async () => {
          const r = await logApplication(fd);
          if (r?.ok) { setOpen(false); setError(null); }
          else setError(r?.error ?? "Could not save that.");
        })
      }
    >
      <input name="company" placeholder="Company" autoFocus required
             style={fieldStyle} disabled={pending} />
      <input name="role" placeholder="Role" required
             style={fieldStyle} disabled={pending} />
      <button className="log" type="submit" disabled={pending}>
        {pending ? "Saving" : "Save"}
      </button>
      <button type="button" className="linkish" onClick={() => setOpen(false)} disabled={pending}>
        Cancel
      </button>
      {error ? <span className="linkish" style={{ border: 0, color: "var(--accent)" }}>{error}</span> : null}
    </form>
  );
}

const fieldStyle: React.CSSProperties = {
  fontFamily: "var(--mono)",
  fontSize: ".82rem",
  background: "transparent",
  color: "var(--fg)",
  border: "1px solid var(--rule)",
  padding: "1rem .9rem",
  minWidth: "12rem",
};
