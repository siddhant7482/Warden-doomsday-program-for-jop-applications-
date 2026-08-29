/* ============================================================
   How Warden reports itself.

   Declared here rather than imported from a shared package on purpose.
   Warden and the hub are separate repos that deploy on their own
   schedule; a shared dependency for twenty lines of types would couple
   two releases that have no reason to be coupled.

   The consumer is responsible for validating what it receives — which
   also means Warden can add fields without anything downstream caring.
   ============================================================ */

export type StatusLevel = "ok" | "warn" | "attention" | "down";

export interface StatusMetric {
  label: string;
  value: string;
}

export interface StatusAlert {
  /** Short and readable out of context — it is shown beside alerts
   *  from other apps with only an app tag for company. */
  text: string;
  /** ISO 8601. Consumers order across apps by this. */
  due?: string;
  severity: "info" | "soon" | "urgent";
  /** Path within Warden, e.g. "/pipeline". */
  href?: string;
}

export interface AppStatus {
  app: string;
  level: StatusLevel;
  headline: string;
  metrics: StatusMetric[];
  alerts: StatusAlert[];
  at: string;
}

export interface CaptureResult {
  ok: boolean;
  message: string;
}
