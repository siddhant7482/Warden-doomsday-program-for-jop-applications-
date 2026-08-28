# Warden

A job-application tracker that reads your inbox and gets progressively
crueller until you apply for something.

Not a CRM. You never type into it. It reads two Gmail accounts, works out
which applications exist and what happened to them, and then does
arithmetic at you until the numbers change.

Part of **CommandHQ**, a homelab running on a Lenovo ThinkCentre M900 Tiny.

---

## The problem

I have ADHD. Applying for jobs is forty minutes of tedium with a ~2% hit
rate and a reward horizon measured in weeks — close to the worst possible
reward structure for my brain. Every tracker I have tried died in week
two, because every tracker requires you to type into it, and typing into
it is the thing I will not do.

Every motivational system I have tried also died, for a different reason:
**a signal that looks the same every day becomes invisible.** Streaks,
daily reminders, badge counts — all wallpaper inside a fortnight. That is
habituation, not laziness, and you cannot discipline your way out of it.

So Warden is built around two rules.

## Rule 1 — you never enter data

The application count has to be *true*, because everything else is
arithmetic on top of it. So it comes from the only source that cannot be
fudged: the confirmation emails already sitting in your inbox.

```
Gmail search  ->  pattern parsers  ->  LLM for the tail  ->  resolution  ->  applications
```

- **Gmail search** narrows before fetching. Excluding 90% of a mailbox
  costs one API call; fetching everything costs one call per message.
- **Deterministic parsers** handle the templated bulk — Greenhouse,
  Workday, Lever, Ashby, LinkedIn, Indeed. **93% of volume**, and code
  cannot hallucinate a company that was never in the email.
- **An LLM reads only what patterns could not** — human prose, unknown
  ATSs, and rejections phrased so politely they never use the word.
  Roughly 7% of volume.
- **Resolution** collapses six emails into one application. This is the
  hard part, not the reading: one application throws off a confirmation,
  a screening note, an assessment invite and a rejection, usually across
  separate threads from `no-reply@greenhouse.io` with the company name
  only in the body.

Throughout, one rule: **prefer nothing over a guess.** A wrong company
invents an application that never existed, which quietly inflates the
number the whole system stands on.

### Things that turned out to matter

- **Email is hard-wrapped at ~72 characters.** `"we have decided to
  move\nforward with other candidates"` splits a rejection phrase across
  a newline and every naive pattern silently misses it.
- **LinkedIn job alerts read exactly like LinkedIn confirmations.** The
  only reliable discriminator is the sender subdomain — `jobs-noreply@`
  versus `jobalerts-noreply@`. Get it wrong and the count inflates.
- **Recruiter cold outreach names a company and a role and reads like
  good news.** It is not an application and must never be counted.
- **Silence is a verdict.** No reply for 60 days marks an application
  `ghosted` automatically, so nothing sits in the pipeline pretending to
  be alive.

## Rule 2 — real urgency, never fake

You cannot fake urgency for yourself; you would know you invented the
deadline. So Warden never nags. It does arithmetic out loud:

```
required rate = (target - done) / days left in month
```

Skip four days and the rate climbs from 3.2 to 4.3 on its own. You moved
it. A message can be argued with; a number that got worse while you did
nothing cannot — and because it is a different number every morning, it
never habituates.

**The daily floor** stops one token application at 11pm clearing the
ladder. It scales with the required rate, so it hardens while you slack.
It is also **capped at twice the flat run-rate**: late in a blown month
the honest rate goes vertical (92 left, 4 days = 23/day), and a floor of
23 is not a demand, it is a reason to stop opening the app. An unwinnable
system is worse than no system. The monthly number stays honest; only the
ask is made clearable.

**The escalation ladder** climbs while you miss and comes down one rung
per compliant day — never by waiting it out.

| Missed days | What fires |
|---|---|
| 1 | Notification |
| 2 | Full-screen notice |
| 3 | **Warning: tomorrow this goes to a friend** |
| 4 / 6 / 9 | Three real friends, emailed in turn |

Day 3 is the important row. The warning is the lever; the email is only
the consequence. Once it has been sent the pressure is discharged and you
have nothing left to lose that day.

**The interface is the punishment.** On pace it is ink on paper — calm,
spare, and it withholds approval rather than congratulating you. Two days
behind, the ground inverts. Six days in, the entire screen is the alarm
and the typeface switches to a serif because it has started issuing
formal notices. You can swipe away a message. You cannot swipe away the
room being on fire.

**The daily message is generated fresh from your own figures.** Specific
and factual beats loud — an insult is dismissible, your own record is
not. Profanity is rationed to at most one word, placed as the last beat
of a line, and only at the deep end; used constantly it stops landing
inside a week. The last five messages are fed back in so thirty
consecutive mornings never rhyme. There is a tone dial, because on a
genuinely bad day the difference between harsh and unusable matters.

## Stack

Next.js · TypeScript · Postgres + Drizzle · OpenRouter · Gmail API
(readonly) · plain CSS. No Tailwind, no UI kit, no `googleapis` SDK —
this deploys to an LXC container on a 4-thread machine with ~120GB of
disk shared across every app on it.

The Gmail refresh token is encrypted at rest with AES-256-GCM. It never
expires and reads the whole mailbox, and the nightly `pg_dump` goes
offsite — plaintext would put a standing key to my email in someone
else's storage.

## Running it

```bash
pnpm install
docker compose -f docker-compose.dev.yml up -d
cp apps/warden/.env.example apps/warden/.env.local   # then fill it in
pnpm --filter warden db:push
pnpm --filter warden ingest      # 27 fixture emails, no Gmail needed
pnpm --filter warden dev
```

The fixture inbox is deliberately adversarial: job alerts that mimic
confirmations, a rejection whose phrase spans a line break, an
application confirmed on one platform and rejected on another weeks
later, a re-application that must not double-count, and an ATS nobody has
written a parser for.

```bash
pnpm --filter warden check:parsers   # what the parsers make of it
pnpm --filter warden check:engine    # a month of slacking, simulated
pnpm --filter warden check:llm       # both OpenRouter call sites
pnpm --filter warden check:gmail     # MIME decoding + token encryption
pnpm --filter warden sync --dry      # real Gmail, writes nothing
```

## Status

Working: ingestion, resolution, auto-ghosting, the enforcement engine,
both screens, OpenRouter.

Built but unarmed: Gmail sync. Nothing connects to a real mailbox until
the server is up.

Built but unarmed: the witness emails and the nightly job. The ladder is
evaluated and sent by `warden-tick` at 09:00, but `settings.armed`
defaults to false and arming is refused while any witness still has a
placeholder address — an armed bluff is worse than an unarmed one.

```bash
pnpm --filter warden tick          # dry run: exactly what would send
pnpm --filter warden tick --arm    # turn it on
```

See [deploy/](deploy/) for the systemd units.
