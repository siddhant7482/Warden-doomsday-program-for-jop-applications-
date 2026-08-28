import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { authorizeUrl, isConfigured } from "@/gmail/oauth";
import { hasEncryptionKey } from "@/lib/crypto";

export const dynamic = "force-dynamic";

/* Starts the Gmail authorisation. Refuses to begin if the encryption
 * key is missing — better to stop here than to receive a refresh token
 * with nowhere safe to put it. */
export async function GET() {
  if (!isConfigured()) {
    return NextResponse.json(
      { error: "Google OAuth is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI." },
      { status: 500 },
    );
  }
  if (!hasEncryptionKey()) {
    return NextResponse.json(
      { error: "TOKEN_ENCRYPTION_KEY is not set. The refresh token is stored encrypted; generate a key first." },
      { status: 500 },
    );
  }

  // CSRF guard: this value comes back on the redirect and must match.
  const state = randomBytes(24).toString("base64url");
  const jar = await cookies();
  jar.set("warden_oauth_state", state, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 600,
    secure: process.env.NODE_ENV === "production",
  });

  return NextResponse.redirect(authorizeUrl(state));
}
