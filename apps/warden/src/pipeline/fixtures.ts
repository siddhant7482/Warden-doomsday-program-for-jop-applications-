/* ============================================================
   Fixture inbox.

   Shaped exactly like what the Gmail API hands back, so swapping the
   live feed in later is a source change and nothing else.

   This is not a happy-path sample. It deliberately includes the things
   that break naive ingestion:

     - LinkedIn confirmations vs LinkedIn job alerts, which differ only
       by sender subdomain and read almost identically
     - a Greenhouse confirmation and its rejection arriving as separate
       threads weeks apart, which must resolve to ONE application
     - Workday mail where the company appears only in the sender domain
     - a recruiter cold email naming a company and a role, which looks
       like a confirmation and must not be counted as one
     - a re-application to a company already applied to
     - an ATS nobody has written a parser for yet
   ============================================================ */

export interface RawEmail {
  gmailId: string;
  threadId: string;
  account: string;
  from: string;
  to: string;
  subject: string;
  receivedAt: string;
  snippet: string;
  body: string;
}

/** Fixtures are relative to today so silence and ghost maths stay live. */
function daysAgo(n: number, hour = 9, minute = 14): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

const A = "siddh.primary@gmail.com";
const B = "siddh.apps@gmail.com";

export const FIXTURES: RawEmail[] = [
  /* ---------- LinkedIn Easy Apply: real confirmations ---------- */
  {
    gmailId: "lnk-001", threadId: "t-lnk-001", account: A,
    from: "LinkedIn <jobs-noreply@linkedin.com>", to: A,
    subject: "your application was sent to Monzo",
    receivedAt: daysAgo(2),
    snippet: "Your application was sent to Monzo",
    body: `Your application was sent to Monzo

Junior Analyst, Risk
Monzo · London, England, United Kingdom (Hybrid)
Applied on ${new Date(daysAgo(2)).toDateString()}

See how you compare to other applicants.`,
  },
  {
    gmailId: "lnk-002", threadId: "t-lnk-002", account: A,
    from: "LinkedIn <jobs-noreply@linkedin.com>", to: A,
    subject: "your application was sent to Deliveroo",
    receivedAt: daysAgo(4),
    snippet: "Your application was sent to Deliveroo",
    body: `Your application was sent to Deliveroo

Analytics Graduate
Deliveroo · London, England, United Kingdom
Applied on ${new Date(daysAgo(4)).toDateString()}`,
  },

  /* ---------- LinkedIn job alert: NOISE.
       Same brand, near-identical layout. Only the sender subdomain
       separates it from the two above. Counting these inflates the
       monthly number, which is the failure mode that matters most. ---- */
  {
    gmailId: "lnk-900", threadId: "t-lnk-900", account: A,
    from: "LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>", to: A,
    subject: '"data analyst": Revolut and 9 more jobs for you',
    receivedAt: daysAgo(1),
    snippet: "Revolut, Wise, Starling Bank and 7 more are hiring",
    body: `Jobs for you

Data Analyst — Revolut — London (Hybrid)
Graduate Data Analyst — Wise — London
Business Analyst — Starling Bank — London

See all 10 jobs`,
  },
  {
    gmailId: "lnk-901", threadId: "t-lnk-901", account: B,
    from: "LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>", to: B,
    subject: "30+ new Data Analyst jobs in London",
    receivedAt: daysAgo(3),
    snippet: "Your job alert for data analyst",
    body: `Your job alert for data analyst in London, England

Junior Data Analyst — Depop
Data Analyst — Cazoo`,
  },

  /* ---------- Indeed ---------- */
  {
    gmailId: "ind-001", threadId: "t-ind-001", account: B,
    from: "Indeed Apply <noreply@indeed.com>", to: B,
    subject: "Indeed Application: Junior Data Analyst",
    receivedAt: daysAgo(8),
    snippet: "You applied to Junior Data Analyst at Depop",
    body: `Indeed Application

You applied to:
Junior Data Analyst
Depop — London

Your application has been submitted.`,
  },
  {
    gmailId: "ind-900", threadId: "t-ind-900", account: B,
    from: "Indeed <alert@indeed.com>", to: B,
    subject: "10 new jobs for data analyst in London",
    receivedAt: daysAgo(2),
    snippet: "New jobs matching data analyst",
    body: `New jobs for you
Data Analyst — Tesco — Welwyn Garden City
Analytics Associate — ASOS — London`,
  },

  /* ---------- Greenhouse: confirmation now, rejection later.
       Separate threads, 24 days apart, sender identical. Resolution
       has to stitch these into one application from body content. ---- */
  {
    gmailId: "gh-001", threadId: "t-gh-001", account: A,
    from: "Octopus Energy <no-reply@greenhouse.io>", to: A,
    subject: "Thank you for applying to Octopus Energy",
    receivedAt: daysAgo(26),
    snippet: "Thanks for your interest in Octopus Energy",
    body: `Hi Siddh,

Thanks for applying to the Graduate Data Analyst role at Octopus Energy.

Our team is reviewing applications and will be in touch.

— The Octopus Energy Recruiting Team`,
  },
  {
    gmailId: "gh-002", threadId: "t-gh-002", account: A,
    from: "Octopus Energy <no-reply@greenhouse.io>", to: A,
    subject: "Your application to Octopus Energy",
    receivedAt: daysAgo(2),
    snippet: "we have decided to move forward with other candidates",
    body: `Hi Siddh,

Thank you for your interest in the Graduate Data Analyst position at
Octopus Energy. After careful consideration we have decided to move
forward with other candidates for this role.

We wish you the best in your search.`,
  },
  {
    gmailId: "gh-003", threadId: "t-gh-003", account: A,
    from: "Trainline <no-reply@greenhouse.io>", to: A,
    subject: "Thank you for applying to Trainline",
    receivedAt: daysAgo(17),
    snippet: "Thanks for applying to Trainline",
    body: `Thanks for applying to the Data Analyst, Graduate role at Trainline.
Location: London Bridge. We will review and be in touch.`,
  },

  /* ---------- Workday: company only in the sender domain ---------- */
  {
    gmailId: "wd-001", threadId: "t-wd-001", account: A,
    from: "Sky Careers <sky@myworkday.com>", to: A,
    subject: "Thank you for your application",
    receivedAt: daysAgo(14),
    snippet: "We have received your application",
    body: `Dear Siddh,

Thank you for your application for Junior Data Scientist (R-104882).

You can check the status of your application at any time by signing in
to your candidate home.`,
  },
  {
    gmailId: "wd-002", threadId: "t-wd-002", account: A,
    from: "Ocado Group <ocado@myworkday.com>", to: A,
    subject: "Thank you for your application",
    receivedAt: daysAgo(20),
    snippet: "Your application has been received",
    body: `Thank you for applying to Data Engineer, Graduate (R-2291) at Ocado Technology.
Location: Hatfield.`,
  },
  {
    gmailId: "wd-003", threadId: "t-wd-003", account: A,
    from: "Vodafone <vodafone@myworkday.com>", to: A,
    subject: "Update on your application",
    receivedAt: daysAgo(12),
    snippet: "we will not be progressing your application",
    body: `Dear Siddh,

Thank you for your interest in the Data Analyst role at Vodafone.
On this occasion we will not be progressing your application further.`,
  },

  /* ---------- Lever + Ashby ---------- */
  {
    gmailId: "lv-001", threadId: "t-lv-001", account: A,
    from: "Starling Bank <no-reply@hire.lever.co>", to: A,
    subject: "Thanks for applying to Starling Bank",
    receivedAt: daysAgo(7),
    snippet: "We have received your application",
    body: `Hi Siddh,

Thanks for your interest in the Business Analyst role at Starling Bank.
We have received your application and will review it shortly.`,
  },
  {
    gmailId: "ash-001", threadId: "t-ash-001", account: A,
    from: "Monzo <no-reply@ashbyhq.com>", to: A,
    subject: "Application received — Monzo",
    receivedAt: daysAgo(21),
    snippet: "We received your application to Monzo",
    body: `We received your application for Junior Analyst, Risk at Monzo.`,
  },
  {
    gmailId: "ash-002", threadId: "t-ash-001", account: A,
    from: "Monzo Talent <talent@monzo.com>", to: A,
    subject: "Re: Application received — Monzo",
    receivedAt: daysAgo(6),
    snippet: "we would love to move you to the next stage",
    body: `Hi Siddh,

Good news — we would love to move you to the next stage for
Junior Analyst, Risk. Someone will be in touch to arrange a call.`,
  },

  /* ---------- Assessments: deadline-bearing, highest priority ---------- */
  {
    gmailId: "shl-001", threadId: "t-shl-001", account: A,
    from: "SHL <no-reply@shl.com>", to: A,
    subject: "Your assessment for Revolut is ready",
    receivedAt: daysAgo(2),
    snippet: "Please complete your assessment by",
    body: `Hello Siddh,

Revolut has invited you to complete an online assessment for the
Analytics Associate role.

Assessment: Numerical Reasoning + Deductive Logic (55 minutes)
Please complete by: ${new Date(Date.now() + 2 * 864e5).toDateString()}

Begin assessment: https://shl.com/start/abc123`,
  },
  {
    gmailId: "hr-001", threadId: "t-hr-001", account: A,
    from: "HackerRank <noreply@hackerrank.com>", to: A,
    subject: "Sky invited you to a test",
    receivedAt: daysAgo(5),
    snippet: "You have been invited to take a test",
    body: `Hi Siddh,

Sky has invited you to take the "Data Science Screen" test.
Duration: 90 minutes. SQL and Python.

This invitation expires on ${new Date(Date.now() + 6 * 864e5).toDateString()}.`,
  },

  /* ---------- Interview bookings ---------- */
  {
    gmailId: "cal-001", threadId: "t-ash-001", account: A,
    from: "Monzo Talent <talent@monzo.com>", to: A,
    subject: "Interview confirmed — Junior Analyst, Risk",
    receivedAt: daysAgo(3),
    snippet: "Your interview is confirmed",
    body: `Hi Siddh,

Your interview for Junior Analyst, Risk at Monzo is confirmed.

When: ${new Date(Date.now() + 3 * 864e5).toDateString()} at 14:30 BST
Format: Video call (45 minutes)
Link: https://meet.google.com/abc-defg-hij`,
  },
  {
    gmailId: "tl-001", threadId: "t-gh-003", account: A,
    from: "Trainline Recruiting <recruiting@trainline.com>", to: A,
    subject: "Interview invitation — Data Analyst, Graduate",
    receivedAt: daysAgo(4),
    snippet: "We would like to invite you to interview",
    body: `Hi Siddh,

We would like to invite you to an onsite interview for the
Data Analyst, Graduate role.

Date: ${new Date(Date.now() + 7 * 864e5).toDateString()}, 10:00
Where: Trainline, 120 Holborn, London`,
  },

  /* ---------- Recruiter cold outreach: NOISE.
       Names a company and a role and reads like progress. It is not an
       application and must never touch the count. ---- */
  {
    gmailId: "rec-900", threadId: "t-rec-900", account: A,
    from: "Hannah Reeve <hannah@talentbridge.co.uk>", to: A,
    subject: "Data Analyst opportunity at Darktrace",
    receivedAt: daysAgo(6),
    snippet: "I came across your profile and thought of you",
    body: `Hi Siddh,

I came across your profile and thought you would be a great fit for a
Data Analyst role I am recruiting for at Darktrace in Cambridge.

Would you be open to a quick chat this week?

Hannah Reeve — TalentBridge`,
  },
  {
    gmailId: "rec-901", threadId: "t-rec-901", account: B,
    from: "Marcus Bell <m.bell@aptitude-search.com>", to: B,
    subject: "Graduate Analyst roles — are you still looking?",
    receivedAt: daysAgo(9),
    snippet: "I have several graduate analyst roles",
    body: `Siddh,

I have several graduate analyst positions with clients in London
paying £32-40k. Let me know if you would like to hear more.`,
  },

  /* ---------- Duplicate application ---------- */
  {
    gmailId: "gh-004", threadId: "t-gh-004", account: B,
    from: "Octopus Energy <no-reply@greenhouse.io>", to: B,
    subject: "Thank you for applying to Octopus Energy",
    receivedAt: daysAgo(1),
    snippet: "Thanks for your interest in Octopus Energy",
    body: `Thanks for applying to the Graduate Data Analyst role at Octopus Energy.
Our team is reviewing applications.`,
  },

  /* ---------- Unknown ATS: no parser exists. Falls to the LLM ---------- */
  {
    gmailId: "unk-001", threadId: "t-unk-001", account: A,
    from: "Zopa Careers <careers@teamtailor-mail.com>", to: A,
    subject: "We got your application, Siddh",
    receivedAt: daysAgo(37),
    snippet: "Thanks for applying to Zopa",
    body: `Hey Siddh!

Nice one — your application for Risk Analyst at Zopa landed safely.
We read every single one. Sit tight and we will come back to you.`,
  },
  {
    gmailId: "unk-002", threadId: "t-unk-002", account: A,
    from: "National Grid Careers <earlycareers@nationalgrid.com>", to: A,
    subject: "Application acknowledgement",
    receivedAt: daysAgo(58),
    snippet: "Your application for Graduate Analyst",
    body: `Dear Applicant,

This is to acknowledge receipt of your application for the position of
Graduate Analyst, based in Warwick.

Applications are being reviewed on a rolling basis.`,
  },

  /* ---------- Ambiguous rejection: no template, polite phrasing, the
       word "reject" never appears. Pattern rules will not catch this. -- */
  {
    gmailId: "amb-001", threadId: "t-unk-003", account: A,
    from: "Rhian Powell <rhian.powell@asos.com>", to: A,
    subject: "Re: BI Developer, Junior",
    receivedAt: daysAgo(11),
    snippet: "we have gone with someone whose experience",
    body: `Hi Siddh,

Thanks so much for taking the time with us. It was a close one, but
we have gone with someone whose experience lines up a little more
closely with where the team is right now.

Please do keep an eye on our careers page — I would genuinely
encourage you to apply again.

Rhian`,
  },

  /* ---------- Pure noise ---------- */
  {
    gmailId: "noi-900", threadId: "t-noi-900", account: A,
    from: "Medium Daily Digest <noreply@medium.com>", to: A,
    subject: "8 stories for you: data engineering, SQL and more",
    receivedAt: daysAgo(1),
    snippet: "Today's highlights",
    body: `Stories picked for you: Why your data pipeline is slow.`,
  },
  {
    gmailId: "noi-901", threadId: "t-noi-901", account: B,
    from: "Student Finance England <noreply@slc.co.uk>", to: B,
    subject: "Your statement is ready",
    receivedAt: daysAgo(5),
    snippet: "Your annual statement",
    body: `Your annual statement is now available to view online.`,
  },
];
