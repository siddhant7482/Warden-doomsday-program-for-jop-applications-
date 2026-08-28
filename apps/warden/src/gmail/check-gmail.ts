import "@/env";

import { encryptSecret, decryptSecret } from "@/lib/crypto";
import { toRawEmail, defaultQuery } from "./client";
import { parseEmail } from "@/pipeline/parse";
import { isConfigured } from "./oauth";

/* Verifies everything up to the network: token encryption, MIME
 * decoding, HTML fallback, and that a real-shaped Gmail payload comes
 * out the far end as a correct application.
 *
 * Hitting Google needs credentials and is a deployment step. */

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const line = () => console.log("-".repeat(70));

/* A Greenhouse confirmation as Gmail actually returns it:
 * multipart/alternative, base64url, and the plain-text part hard
 * wrapped the way real mail is. */
const MULTIPART = {
  id: "18f2c9a1b7d3e4f5",
  threadId: "18f2c9a1b7d3e4f5",
  snippet: "Thanks for applying to Octopus Energy",
  internalDate: String(Date.now() - 3 * 864e5),
  payload: {
    mimeType: "multipart/alternative",
    headers: [
      { name: "From", value: "Octopus Energy <no-reply@greenhouse.io>" },
      { name: "To", value: "siddh.primary@gmail.com" },
      { name: "Subject", value: "Thank you for applying to Octopus Energy" },
    ],
    parts: [
      {
        mimeType: "text/plain",
        body: {
          data: b64(
            "Hi Siddh,\n\nThanks for applying to the Graduate Data Analyst role at\nOctopus Energy.\n\nLocation: London\n\nOur team is reviewing applications.\n",
          ),
        },
      },
      { mimeType: "text/html", body: { data: b64("<p>ignored when plain text exists</p>") } },
    ],
  },
};

/* HTML-only, which a lot of ATS mail is. Also nested one level deeper
 * and carrying an attachment that must be skipped. */
const HTML_ONLY = {
  id: "18f2c9a1b7d3e4f6",
  threadId: "18f2c9a1b7d3e4f6",
  snippet: "We will not be progressing your application",
  internalDate: String(Date.now() - 1 * 864e5),
  payload: {
    mimeType: "multipart/mixed",
    headers: [
      { name: "From", value: "Vodafone <vodafone@myworkday.com>" },
      { name: "Subject", value: "Update on your application" },
    ],
    parts: [
      {
        mimeType: "multipart/alternative",
        parts: [
          {
            mimeType: "text/html",
            body: {
              data: b64(
                "<html><style>p{color:red}</style><body><p>Dear Siddh,</p>" +
                  "<div>Thank you for your interest in the Data&nbsp;Analyst role at Vodafone.</div>" +
                  "<div>On this occasion we will not be progressing your application further.</div>" +
                  "</body></html>",
              ),
            },
          },
        ],
      },
      { mimeType: "application/pdf", filename: "terms.pdf", body: { data: b64("SHOULD NOT APPEAR") } },
    ],
  },
};

function report(name: string, msg: Parameters<typeof toRawEmail>[0]) {
  const raw = toRawEmail(msg, "siddh.primary@gmail.com");
  const p = parseEmail(raw);
  console.log(`\n${name}`);
  console.log(`  from       ${raw.from}`);
  console.log(`  subject    ${raw.subject}`);
  console.log(`  received   ${raw.receivedAt.slice(0, 10)}`);
  console.log(`  body       ${JSON.stringify(raw.body.slice(0, 96))}${raw.body.length > 96 ? "…" : ""}`);
  console.log(`  ->  ${p.kind} (${p.confidence.toFixed(2)}) via ${p.platform}`);
  console.log(`      company: ${p.company ?? "—"}   role: ${p.role ?? "—"}   location: ${p.location ?? "—"}`);
  return { raw, p };
}

console.log("\nTOKEN ENCRYPTION");
line();
try {
  /* Deliberately does not look like a Google refresh token — a realistic
   * prefix here trips secret scanners on every push for no reason. */
  const secret = "not-a-real-token-round-trip-fixture-0000";
  const sealed = encryptSecret(secret);
  const opened = decryptSecret(sealed);
  console.log(`  sealed     ${sealed.slice(0, 46)}…  (${sealed.length} chars)`);
  console.log(`  round trip ${opened === secret ? "OK — matches" : "FAILED"}`);
  let tampered = sealed.split(".");
  tampered[3] = Buffer.from("tampered payload").toString("base64url");
  try {
    decryptSecret(tampered.join("."));
    console.log("  tamper     NOT DETECTED — this is a bug");
  } catch {
    console.log("  tamper     rejected, as it should be");
  }
} catch (e) {
  console.log(`  FAILED — ${(e as Error).message.split("\n")[0]}`);
}

console.log("\n\nGMAIL PAYLOAD -> APPLICATION");
line();
const a = report("multipart/alternative, plain text preferred", MULTIPART as never);
const b = report("HTML only, nested, with an attachment to skip", HTML_ONLY as never);

console.log("\n  checks");
const checks: Array<[string, boolean]> = [
  ["plain text chosen over HTML", !a.raw.body.includes("ignored when")],
  ["hard wrap survives parsing", a.p.role === "Graduate Data Analyst"],
  ["company from ATS display name", a.p.company === "Octopus Energy"],
  ["location extracted", a.p.location === "London"],
  ["HTML stripped to readable text", !b.raw.body.includes("<div>")],
  ["style block removed", !b.raw.body.includes("color:red")],
  ["&nbsp; decoded", b.raw.body.includes("Data Analyst")],
  ["attachment skipped", !b.raw.body.includes("SHOULD NOT APPEAR")],
  ["rejection detected in HTML mail", b.p.kind === "rejection"],
  ["role not polluted by 'interest in the'", b.p.role === "Data Analyst"],
];
for (const [label, ok] of checks) console.log(`    ${ok ? "ok  " : "FAIL"}  ${label}`);
const failed = checks.filter(([, ok]) => !ok).length;

console.log("\n\nGMAIL SEARCH QUERY (narrows before fetching)");
line();
console.log("  " + defaultQuery(90).replace(/ OR /g, " OR ").slice(0, 260) + "…");

console.log("\n\nCREDENTIALS");
line();
console.log(`  Google OAuth configured : ${isConfigured() ? "yes" : "no — deployment step, expected"}`);
console.log(`  Encryption key present  : ${process.env.TOKEN_ENCRYPTION_KEY ? "yes" : "no"}`);
console.log();

process.exit(failed > 0 ? 1 : 0);
