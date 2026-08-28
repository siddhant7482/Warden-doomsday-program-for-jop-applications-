import {
  pgTable,
  pgEnum,
  serial,
  text,
  integer,
  real,
  boolean,
  date,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/* ============================================================
   WARDEN — schema
   Two hard requirements shape all of this:

   1. The application count must be TRUE. The whole enforcement
      engine is arithmetic on top of it, so every number has to be
      traceable back to a specific email. Nothing is self-reported
      without being auditable.
   2. Applications must never sit in limbo lying about being alive.
      Silence past `ghostDays` is a verdict, applied automatically.
   ============================================================ */

/* ---------------- enums ---------------- */

/** Where the application was submitted. Drives the cost-per-platform
 *  question: a Workday form is ~18 minutes, an Easy Apply is ~2. */
export const platformEnum = pgEnum("platform", [
  "linkedin",
  "indeed",
  "workday",
  "greenhouse",
  "lever",
  "ashby",
  "smartrecruiters",
  "icims",
  "reed",
  "totaljobs",
  "direct",
  "other",
]);

/** Lifecycle of one application. `ghosted` is only ever set by the
 *  system, never by a human — it means silence, not a decision. */
export const statusEnum = pgEnum("application_status", [
  "applied",
  "in_review",
  "assessment",
  "interview",
  "offer",
  "accepted",
  "rejected",
  "ghosted",
  "withdrawn",
]);

/** What an ingested email actually is. The three noise classes at the
 *  end matter as much as the signal ones — misfiling a job alert as a
 *  confirmation inflates the count, which is the worst failure mode. */
export const emailKindEnum = pgEnum("email_kind", [
  "confirmation",
  "progress",
  "assessment",
  "interview",
  "offer",
  "rejection",
  "recruiter_outreach",
  "job_alert",
  "noise",
  "unknown",
]);

/** How an email was understood. Pattern parsers are deterministic and
 *  cannot hallucinate; the LLM only ever sees what patterns missed. */
export const parsedByEnum = pgEnum("parsed_by", ["pattern", "llm", "manual"]);

/** Rungs of the escalation ladder, in order of severity. */
export const noticeKindEnum = pgEnum("notice_kind", [
  "notification",
  "fullscreen",
  "warning",
  "witness_email",
  "heartbeat",
]);

/* ---------------- mail accounts ---------------- */

export const accounts = pgTable("accounts", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  label: text("label"),
  /** Gmail `historyId` cursor. Incremental sync resumes from here so we
   *  never re-walk the whole mailbox. Null until the first full sync. */
  historyId: text("history_id"),
  refreshToken: text("refresh_token"),
  active: boolean("active").notNull().default(true),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ---------------- applications ---------------- */

export const applications = pgTable(
  "applications",
  {
    id: serial("id").primaryKey(),

    company: text("company").notNull(),
    role: text("role").notNull(),
    location: text("location"),

    /** Salary is stored three ways on purpose: the raw string as written
     *  (often "competitive" or absent), plus a parsed range when one
     *  exists. A null range with a non-null raw is meaningful data. */
    salaryRaw: text("salary_raw"),
    salaryMin: integer("salary_min"),
    salaryMax: integer("salary_max"),
    salaryCurrency: text("salary_currency").default("GBP"),

    url: text("url"),
    platform: platformEnum("platform").notNull().default("other"),
    accountId: integer("account_id").references(() => accounts.id),

    status: statusEnum("status").notNull().default("applied"),
    appliedAt: timestamp("applied_at", { withTimezone: true }).notNull(),

    /** Last time they contacted us about this. Silence is measured from
     *  here, not from appliedAt — a reply resets the ghost clock. */
    lastContactAt: timestamp("last_contact_at", { withTimezone: true }).notNull(),

    /** The only two things that ever actually need the user: an
     *  assessment deadline or a booked interview. */
    nextActionAt: timestamp("next_action_at", { withTimezone: true }),
    nextActionLabel: text("next_action_label"),

    /** normalise(company) + "|" + normalise(role). Not unique — applying
     *  again after six months is legitimate — but it's how we catch the
     *  re-applications that would otherwise inflate the monthly count. */
    dedupeKey: text("dedupe_key").notNull(),
    duplicateOfId: integer("duplicate_of_id"),

    /** True when a human added this by hand because no confirmation
     *  email ever arrived. Kept separate so we can measure how much of
     *  the count is unverifiable. */
    manual: boolean("manual").notNull().default(false),

    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("applications_status_idx").on(t.status),
    index("applications_dedupe_idx").on(t.dedupeKey),
    index("applications_applied_idx").on(t.appliedAt),
    index("applications_contact_idx").on(t.lastContactAt),
  ],
);

/* ---------------- ingested email ---------------- */

export const emails = pgTable(
  "emails",
  {
    id: serial("id").primaryKey(),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id),

    /** Gmail's own message id. The unique index here is what makes
     *  ingestion idempotent — re-running a sync can never double-count. */
    gmailId: text("gmail_id").notNull(),
    threadId: text("thread_id"),

    fromAddr: text("from_addr").notNull(),
    fromName: text("from_name"),
    subject: text("subject"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    snippet: text("snippet"),
    body: text("body"),

    kind: emailKindEnum("kind").notNull().default("unknown"),
    parsedBy: parsedByEnum("parsed_by").notNull().default("pattern"),
    /** e.g. "greenhouse.confirmation" — which rule fired, so a bad
     *  parser can be found and fixed rather than guessed at. */
    parserId: text("parser_id"),
    confidence: real("confidence"),

    /** Whatever the parser or model pulled out, before resolution. */
    extracted: jsonb("extracted"),

    applicationId: integer("application_id").references(() => applications.id),
    /** Set when resolution couldn't confidently attach this to an
     *  application. These are the rows worth reviewing by hand. */
    unresolved: boolean("unresolved").notNull().default(false),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("emails_gmail_id_idx").on(t.accountId, t.gmailId),
    index("emails_application_idx").on(t.applicationId),
    index("emails_kind_idx").on(t.kind),
    index("emails_received_idx").on(t.receivedAt),
  ],
);

/* ---------------- enforcement ---------------- */

/** One row per day. Written by the engine, kept as history because the
 *  floor is recomputed daily and we want the record of what it was. */
export const dailyLog = pgTable("daily_log", {
  day: date("day").primaryKey(),
  logged: integer("logged").notNull().default(0),
  floor: integer("floor").notNull(),
  requiredRate: real("required_rate").notNull(),
  cleared: boolean("cleared").notNull().default(false),
  restDay: boolean("rest_day").notNull().default(false),
  /** The generated message shown that day, kept so it is never repeated
   *  and so the escalation reads as a sequence rather than a loop. */
  message: text("message"),
  /** Which enforcement state the message was written for. A cached
   *  message is reused only while the state holds — clear the floor and
   *  the voice has to change with it. */
  state: text("state"),
  /** False when the model was unreachable and deterministic copy was
   *  shown instead. Keeps the record honest about what they saw. */
  generated: boolean("generated").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Singleton (id = 1). Current position on the ladder. */
export const escalation = pgTable("escalation", {
  id: integer("id").primaryKey().default(1),
  /** Consecutive days the floor was missed. Comes down one rung per
   *  compliant day, never by waiting — climb fast, descend slow. */
  consecutiveMisses: integer("consecutive_misses").notNull().default(0),
  rung: integer("rung").notNull().default(0),
  /** How many times the ladder has reached witness level before. The
   *  system remembers: repeat offences start higher. */
  repeatOffences: integer("repeat_offences").notNull().default(0),
  lastClearedAt: timestamp("last_cleared_at", { withTimezone: true }),
  restDaysBanked: integer("rest_days_banked").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** The three friends. Each rung's power comes from its rarity, so
 *  `triggerDay` for the last one should be somewhere it almost never
 *  reaches. */
export const witnesses = pgTable("witnesses", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  triggerDay: integer("trigger_day").notNull(),
  active: boolean("active").notNull().default(true),
  /** Weekly "still running" ping. Its absence is the signal that
   *  matters — it means the system was switched off. */
  heartbeat: boolean("heartbeat").notNull().default(true),
  lastNotifiedAt: timestamp("last_notified_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Everything the system has ever fired. Append-only. */
export const notices = pgTable(
  "notices",
  {
    id: serial("id").primaryKey(),
    kind: noticeKindEnum("kind").notNull(),
    rung: integer("rung"),
    witnessId: integer("witness_id").references(() => witnesses.id),
    body: text("body").notNull(),
    firedAt: timestamp("fired_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("notices_fired_idx").on(t.firedAt)],
);

/* ---------------- settings ---------------- */

/** Singleton (id = 1). */
export const settings = pgTable("settings", {
  id: integer("id").primaryKey().default(1),
  monthlyTarget: integer("monthly_target").notNull().default(100),
  /** Daily floor as a fraction of the required rate. At 100/month this
   *  gives a floor of ~3: clearable on a bad day, but never clearable
   *  by logging one thing at 11pm. */
  floorFraction: real("floor_fraction").notNull().default(1.0),
  /** Days of silence before an application is ghosted automatically. */
  ghostDays: integer("ghost_days").notNull().default(60),
  /** Multiple of the daily rate that earns a banked rest day. */
  restDayMultiple: real("rest_day_multiple").notNull().default(2.5),
  /** 0 = clinical, 1 = as written. Turning it down beats abandoning it. */
  tone: real("tone").notNull().default(1.0),
  /** Nothing is emailed to a witness until this is deliberately turned
   *  on. The ladder is calculated and displayed either way — arming only
   *  decides whether it reaches another human. */
  armed: boolean("armed").notNull().default(false),
  /** How the witnesses are told to refer to him. */
  userName: text("user_name").notNull().default("Siddh"),
  timezone: text("timezone").notNull().default("Europe/London"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Application = typeof applications.$inferSelect;
export type NewApplication = typeof applications.$inferInsert;
export type Email = typeof emails.$inferSelect;
export type NewEmail = typeof emails.$inferInsert;
export type Settings = typeof settings.$inferSelect;
export type Witness = typeof witnesses.$inferSelect;
