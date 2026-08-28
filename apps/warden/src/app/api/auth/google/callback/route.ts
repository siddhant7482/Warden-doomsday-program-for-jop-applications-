import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { accounts } from "@/db/schema";
import { encryptSecret } from "@/lib/crypto";
import { exchangeCode, whoAmI } from "@/gmail/oauth";

export const dynamic = "force-dynamic";

function page(title: string, body: string, status = 200) {
  return new NextResponse(
    `<!doctype html><meta charset="utf-8"><title>Warden</title>
     <body style="background:#0b0b0c;color:#dedad1;font:15px/1.6 ui-monospace,monospace;padding:3rem;max-width:52rem">
     <h1 style="letter-spacing:.3em;font-size:.9rem;color:#6b6a66">WARDEN</h1>
     <p style="font-size:1.4rem;letter-spacing:-.01em">${title}</p>
     <p style="color:#8a8781">${body}</p>
     <p><a href="/" style="color:#dedad1">Back to Warden</a></p></body>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) return page("Authorisation refused", `Google returned: ${error}`, 400);
  if (!code || !state) return page("Missing code", "Google did not return an authorisation code.", 400);

  const jar = await cookies();
  const expected = jar.get("warden_oauth_state")?.value;
  jar.delete("warden_oauth_state");
  if (!expected || expected !== state) {
    return page("State mismatch", "This redirect did not originate from Warden. Start again from /api/auth/google.", 400);
  }

  try {
    const tokens = await exchangeCode(code);
    const email = await whoAmI(tokens.access_token);

    // The refresh token never expires and reads the whole mailbox, so
    // it is encrypted before it touches Postgres — backups go offsite.
    const refreshToken = encryptSecret(tokens.refresh_token);

    const [existing] = await db.select().from(accounts).where(eq(accounts.email, email)).limit(1);
    if (existing) {
      await db.update(accounts).set({ refreshToken, active: true }).where(eq(accounts.id, existing.id));
    } else {
      await db.insert(accounts).values({ email, label: null, refreshToken, active: true });
    }

    return page(
      `${email} connected.`,
      "Read-only access to this mailbox. Nothing is synced until you run <code>pnpm sync</code>.",
    );
  } catch (e) {
    return page("Could not complete authorisation", String((e as Error).message), 500);
  }
}
